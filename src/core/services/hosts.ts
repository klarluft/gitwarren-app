/**
 * The host service: adding, listing and reaching other machines.
 *
 * Same contract as every other service - it re-parses its own input, it is the
 * only implementation, and both surfaces call straight into it. What is
 * different is that one of its reads is not from SQLite: reachability comes
 * from the connection pool, live, and is never written down. A host that
 * answered ten minutes ago is not a fact about now.
 *
 * ## Meeting a host
 *
 * A row is created from what someone typed, which is a *description* of a
 * machine. It becomes a *known* machine on the first successful connect, when
 * the host reports its instance id and that gets written back. Everything that
 * follows - `repositories.host_id`, M6's discovery, deciding that two entries
 * are the same box - keys off the instance id and not off the target, because
 * an address is a way to reach a machine and not the machine.
 *
 * The write-back is where the second duplicate check happens, and it is the
 * interesting one: two rows can be perfectly distinct as *descriptions*
 * (`pc-wsl` and `xfor@100.78.0.23`) and turn out to name one machine. Nothing
 * can see that until the machine says so, so the collision is detected on
 * connect rather than in the form, and it is reported rather than merged -
 * silently collapsing two rows would take a repository list with it.
 *
 * ## Why there is no `hosts.connect`
 *
 * Connecting is not something a person does; it is something that happens
 * because they asked for a repository list. The pool decides when, and the only
 * deliberate reach is `probe`, which exists so the Hosts screen can offer a
 * button that says "try now" and mean it.
 */
import { asc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import { hosts, type HostRow } from '../db/schema.js'
import { hostPool, type HostRoute } from '../hosts/pool.js'
import { AppError } from '../../shared/errors.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import {
  addHostInputSchema,
  getHostInputSchema,
  removeHostInputSchema,
  updateHostInputSchema,
  type Host,
  type HostWithState
} from '../../shared/schemas.js'

function toHost(row: HostRow): Host {
  return {
    id: row.id,
    instanceId: row.instanceId,
    label: row.label,
    kind: row.kind,
    target: row.target,
    editorTarget: row.editorTarget,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt
  }
}

function withState(row: HostRow): HostWithState {
  return { ...toHost(row), state: hostPool.state(row.id) }
}

export function routeFor(row: HostRow): HostRoute {
  return { id: row.id, kind: row.kind, target: row.target }
}

function requireRow(id: number): HostRow {
  const row = getDatabase().select().from(hosts).where(eq(hosts.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No host with id ${id}.`)
  return row
}

/**
 * A sensible name for `xfor@pc-wsl`: "pc-wsl".
 *
 * The user part is how to log in, not what the machine is called, and a list of
 * hosts every one of which begins with the same username is a list that has
 * stopped distinguishing anything.
 */
function defaultLabelFor(target: string): string {
  const withoutUser = target.includes('@') ? target.slice(target.indexOf('@') + 1) : target
  return withoutUser || target
}

function asDuplicateError(error: unknown, target: string): AppError {
  const code = (error as { code?: string } | null)?.code
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return new AppError('INVALID_INPUT', `That host is already in the list: ${target}`, {
      target: ['This host is already in the list.']
    })
  }
  return AppError.from(error)
}

/**
 * Record that a host answered, and who it turned out to be.
 *
 * Called after a successful request rather than as part of connecting, because
 * "the pipe opened" and "the daemon answered" are different claims and only the
 * second one is worth writing down.
 */
function recordSeen(row: HostRow, instanceId: string | null): void {
  const database = getDatabase()
  const lastSeenAt = new Date().toISOString()

  if (instanceId && instanceId !== row.instanceId) {
    const other = database.select().from(hosts).where(eq(hosts.instanceId, instanceId)).get()
    if (other && other.id !== row.id) {
      throw new AppError(
        'INVALID_INPUT',
        `${row.target} is the same machine as "${other.label}" (${other.target}), which is ` +
          'already in the list. Remove one of them.',
        { target: ['This machine is already in the list under another name.'] }
      )
    }
    database.update(hosts).set({ instanceId, lastSeenAt }).where(eq(hosts.id, row.id)).run()
    return
  }

  database.update(hosts).set({ lastSeenAt }).where(eq(hosts.id, row.id)).run()
}

export const hostsService = {
  /** Every host, each with its reachability read from the pool. */
  list(): HostWithState[] {
    const rows = getDatabase().select().from(hosts).orderBy(asc(hosts.label)).all()
    return rows.map(withState)
  },

  get(input: unknown): HostWithState {
    const { id } = parse(getHostInputSchema, input)
    return withState(requireRow(id))
  },

  add(input: unknown): HostWithState {
    const { target, label, kind = 'ssh', editorTarget } = parse(addHostInputSchema, input)

    try {
      const row = getDatabase()
        .insert(hosts)
        .values({
          target,
          kind,
          label: label ?? defaultLabelFor(target),
          // Null rather than a derived default: `ssh-remote+<target>` is what
          // `shared/editors.ts` builds when this is absent, and storing the
          // derivation would freeze it at the value it had on the day the host
          // was added.
          editorTarget: editorTarget ?? null
        })
        .returning()
        .get()
      return withState(row)
    } catch (error) {
      throw asDuplicateError(error, target)
    }
  },

  update(input: unknown): HostWithState {
    const { id, label, target, editorTarget } = parse(updateHostInputSchema, input)
    const row = requireRow(id)

    // Repointing at a different machine invalidates the identity we learned:
    // the new address may be a different box entirely, and keeping the old
    // instance id would let a repository row follow the address instead of the
    // machine - which is the one thing the id exists to prevent.
    const movedElsewhere = target !== undefined && target !== row.target

    try {
      const updated = getDatabase()
        .update(hosts)
        .set({
          ...(label !== undefined ? { label } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(editorTarget !== undefined ? { editorTarget } : {}),
          ...(movedElsewhere ? { instanceId: null, lastSeenAt: null } : {})
        })
        .where(eq(hosts.id, id))
        .returning()
        .get()

      if (movedElsewhere) hostPool.disconnect(id)
      return withState(updated)
    } catch (error) {
      throw asDuplicateError(error, target ?? row.target)
    }
  },

  /**
   * Forget a host.
   *
   * The connection is dropped first so that an in-flight request cannot write
   * `last_seen_at` back onto a row that is about to stop existing.
   *
   * Repositories on the host are deliberately *not* deleted here. That is M4.3's
   * decision to make, once there are remote repositories to have an opinion
   * about; leaving orphaned rows for one slice is better than writing a cascade
   * now and having to unpick it.
   */
  remove(input: unknown): { id: number } {
    const { id } = parse(removeHostInputSchema, input)
    requireRow(id)
    hostPool.disconnect(id)
    getDatabase().delete(hosts).where(eq(hosts.id, id)).run()
    return { id }
  },

  /**
   * Reach a host on purpose and report what happened.
   *
   * Ignores backoff - a person pressing "try now" knows something the timer
   * does not, usually that they have just switched the machine on. Never
   * throws: an unreachable host is an answer, and `state.lastError` carries the
   * reason for the screen to show.
   */
  async probe(input: unknown): Promise<HostWithState> {
    const { id } = parse(getHostInputSchema, input)
    const row = requireRow(id)

    const state = await hostPool.probe(routeFor(row))
    if (!state.connected) return { ...toHost(row), state }

    // Reached. Ask who that was, and remember it.
    let instanceId: string | null = null
    try {
      const info = await hostPool.request(routeFor(row), 'app.instance')
      instanceId = info.instanceId
    } catch {
      // A host too old to answer `app.instance` is still a usable host; it just
      // stays anonymous, and `instance_id` keeps saying "not met" - which is
      // true in the only sense that matters here.
    }

    recordSeen(row, instanceId)
    return withState(requireRow(id))
  }
}
