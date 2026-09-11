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
 *
 * `install` is the second deliberate reach, and the exception that proves the
 * rule: putting software on somebody's machine is emphatically something a
 * person does, and it is the one thing here that must never happen because a
 * screen happened to render.
 */
import { asc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import { hosts, type HostRow } from '../db/schema.js'
import { hostPool, type HostRoute } from '../hosts/pool.js'
import { installOnHost } from '../hosts/install.js'
import { listDistros } from '../hosts/wsl.js'
import { normaliseTarget } from '../hosts/websocket.js'
import { refreshExposure, setExposed } from '../web/exposure.js'
import { AppError } from '../../shared/errors.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import {
  addHostInputSchema,
  getHostInputSchema,
  installOnHostInputSchema,
  removeHostInputSchema,
  updateHostInputSchema,
  type Host,
  type HostWithState,
  type InstallReport,
  type WslDistro,
  setTailnetExposureInputSchema,
  type TailnetExposure
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
    daemonVersion: row.daemonVersion,
    createdAt: row.createdAt
  }
}

function withState(row: HostRow): HostWithState {
  return { ...toHost(row), state: hostPool.state(row.id) }
}

export function routeFor(row: HostRow): HostRoute {
  // The instance id rides along since M6.5, for one purpose: an event arriving
  // from this host has to be tagged with the machine it is about, and the pool
  // - which is where the event lands - holds connections rather than rows. Null
  // until the machine has said who it is, which is also exactly the window in
  // which it cannot have pushed anything.
  return { id: row.id, kind: row.kind, target: row.target, instanceId: row.instanceId }
}

/**
 * The host a route or a link names, by the only name that survives a rename, a
 * new address and a change of carrier.
 *
 * Exported because two callers outside this service resolve an instance id and
 * must fail the same way when it is not there: `core/hosts/router.ts`, which is
 * about to forward a request, and the editor launch in `main/ipc.ts`, which
 * needs to know how an editor names that machine. The sentence names the id
 * rather than saying "unknown host", because the id is what the link contained
 * and the only thing a person can compare against their Hosts screen.
 */
export function requireInstance(instanceId: string): HostRow {
  const row = getDatabase().select().from(hosts).where(eq(hosts.instanceId, instanceId)).get()
  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `This GitWarren does not know a host with id ${instanceId}. ` +
        'It may have been removed, or the link may have come from somewhere else.'
    )
  }
  return row
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
  // A websocket target is a URL, so the label people recognise is the first
  // label of its hostname: `http://pc-wsl.tail688c0c.ts.net:41427` is `pc-wsl`.
  // The full name is still on the row and is what gets connected to; this is
  // only what a card says.
  if (/^https?:\/\//i.test(target)) {
    try {
      return new URL(target).hostname.split('.')[0] || target
    } catch {
      return target
    }
  }
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
function recordSeen(row: HostRow, instanceId: string | null, daemonVersion?: string): void {
  const database = getDatabase()
  const lastSeenAt = new Date().toISOString()
  // Written on every sighting rather than only on a change, because the host
  // being upgraded by someone else is exactly the case this column exists to
  // notice, and it costs the same UPDATE either way.
  const version = daemonVersion ? { daemonVersion } : {}

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
    database
      .update(hosts)
      .set({ instanceId, lastSeenAt, ...version })
      .where(eq(hosts.id, row.id))
      .run()
    return
  }

  database
    .update(hosts)
    .set({ lastSeenAt, ...version })
    .where(eq(hosts.id, row.id))
    .run()
}

export const hostsService = {
  /** Every host, each with its reachability read from the pool. */
  list(): HostWithState[] {
    const rows = getDatabase().select().from(hosts).orderBy(asc(hosts.label)).all()
    return rows.map(withState)
  },

  /**
   * The WSL distributions this machine could host a daemon in.
   *
   * Answered here rather than in a shell channel because it is a fact about the
   * machine the *core* runs on - the one that will spawn `wsl.exe` - and a
   * browser tab managing this install's hosts has to be able to ask it. See the
   * note on `hosts.distros` in `shared/rpc.ts`.
   *
   * `alreadyAdded` is joined on here because this is the layer that can see the
   * host table, and a picker that offered a distribution already in the list
   * would be offering the duplicate error rather than preventing it. Compared
   * case-insensitively, because `wsl.exe` matches a distribution name that way
   * while the unique index does not - so `ubuntu` typed by hand and `Ubuntu`
   * from this list are one machine, and the picker should say so before the
   * instance id has to.
   */
  async distros(): Promise<WslDistro[]> {
    const found = await listDistros()
    if (found.length === 0) return []

    const taken = new Set(
      getDatabase()
        .select()
        .from(hosts)
        .where(eq(hosts.kind, 'wsl'))
        .all()
        .map((row) => row.target.toLowerCase())
    )
    return found.map((distro) => ({ ...distro, alreadyAdded: taken.has(distro.name.toLowerCase()) }))
  },

  get(input: unknown): HostWithState {
    const { id } = parse(getHostInputSchema, input)
    return withState(requireRow(id))
  },

  add(input: unknown): HostWithState {
    const { target: typed, label, kind = 'ssh', editorTarget } = parse(addHostInputSchema, input)
    // Stored in the form the carrier will use, not in the form somebody typed.
    // `pc-wsl` and `http://pc-wsl:41427` are the same machine, and letting both
    // into the table would mean two rows the unique index cannot see are one -
    // which M4.1's collision report would then catch on connect, far later than
    // it needs to be caught.
    const target = kind === 'websocket' ? normaliseTarget(typed) : typed

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

    // An ssh target is an *address*, and an address is allowed to change - a
    // machine gets a new name, a config alias is renamed, the tailnet hands out
    // a different one. A WSL host's target is not an address, it is which
    // distribution this is; changing it does not repoint a route at the same
    // machine, it names a different machine with a different home directory and
    // a different database. So it is refused rather than quietly accepted, and
    // the sentence says what to do instead. `update` carries no `kind`, which is
    // why this is here and not in the schema.
    if (movedElsewhere && row.kind === 'wsl') {
      throw new AppError(
        'INVALID_INPUT',
        'A WSL host is identified by its distribution. To review a different one, ' +
          'add it as its own host.',
        { target: ['A WSL host cannot be pointed at a different distribution.'] }
      )
    }

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
   * There is no cascade to repositories, and M4.3 - which was left the decision
   * - found it had nothing to decide. No row in this database ever names a
   * host: a repository on `pc-wsl` is a row in that machine's SQLite, and this
   * install holds only the route to the machine. So forgetting a host forgets a
   * way of reaching a computer, and every repository, review and comment over
   * there is exactly where it was. Adding the host again reaches all of it
   * again. See the note on `repositories.host_id` in the schema.
   *
   * What is *not* removed is anything on the host itself - see "Not done in
   * M4.2": going onto somebody's server to delete a directory is a different
   * act, and the dialog says as much.
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
    let version: string | undefined
    try {
      const info = await hostPool.request(routeFor(row), 'app.instance')
      instanceId = info.instanceId
      version = info.version
    } catch {
      // A host too old to answer `app.instance` is still a usable host; it just
      // stays anonymous, and `instance_id` keeps saying "not met" - which is
      // true in the only sense that matters here.
    }

    recordSeen(row, instanceId, version)
    return withState(requireRow(id))
  },

  /**
   * Put GitWarren on a host, and note what it turned out to be running.
   *
   * The connection is dropped first, and that is not tidiness. The pool may be
   * holding a pipe into the daemon that is about to be replaced on disk, and an
   * `ssh` still attached to the old `lib/gitwarren.cjs` would go on answering
   * from a directory that has been moved out from under it - the version this
   * function reads back at the end would then be the new one while the carrier
   * kept using the old. Hanging up costs a 178 ms reconnect on the multiplexed
   * channel and removes the whole question.
   *
   * The install itself is `core/hosts/install.ts`; what belongs here is what
   * touches the database - forgetting the connection, writing down the version
   * that is now over there, and then reaching the machine again.
   *
   * That last step is not tidiness either. Without it the row handed back says
   * `connected: false, failures: 0`, which the screen renders as "not tried
   * yet" - immediately after somebody watched a progress spinner put GitWarren
   * onto that machine. The daemon has never been *spoken to*, only installed,
   * and the honest way to fix the sentence is to speak to it. It costs a
   * multiplexed reconnect, and it is how the instance id gets learned for a
   * host that has just met GitWarren for the first time.
   *
   * The probe's own failure is swallowed on purpose: an install that worked
   * followed by a connection that did not is still an install that worked, and
   * reporting it as a failed install would send someone to fix the wrong thing.
   * Whatever went wrong is on the row, in `state.lastError`, where the screen
   * shows it.
   */
  async install(input: unknown): Promise<InstallReport> {
    const { id, force } = parse(installOnHostInputSchema, input)
    const row = requireRow(id)

    // The pool may be holding a pipe into the daemon that is about to be
    // replaced on disk. See the note above.
    hostPool.disconnect(id)
    const report = await installOnHost(routeFor(row), { force })

    getDatabase()
      .update(hosts)
      .set({ daemonVersion: report.version })
      .where(eq(hosts.id, id))
      .run()

    try {
      await hostsService.probe({ id })
    } catch {
      // Two machines under one name is the case that lands here, and it is
      // reported the next time anybody probes rather than as a failed install.
    }

    return { ...report, host: withState(requireRow(id)) }
  }
}

/**
 * This machine's tailnet reachability, as a method rather than a shell channel.
 *
 * Appended to `hostsService` rather than given a service of its own because it
 * is the same question the rest of this file answers - how this install is
 * reached, and by what - and because the `hosts.` prefix is what makes
 * `isLocalOnly` refuse to forward it. That refusal is the load-bearing part: a
 * GUI on the Mac must not be able to start `tailscale serve` on the PC.
 *
 * Thin, like every other entry here. The machinery is `core/web/exposure.ts`,
 * which is also what the gate reads, so the panel and the server cannot
 * disagree about whether this install is exposed.
 */
export const tailnetService = {
  /** What is true now. Re-read from the machine, not from memory. */
  read(): Promise<TailnetExposure> {
    return refreshExposure()
  },
  /**
   * Turn it on or off, and answer with what the machine then says.
   *
   * Deliberately not "answer with what was asked for": `tailscale serve
   * --https` on a tailnet with no certificates never returns, so the request
   * and the outcome genuinely differ, and a switch that showed the request
   * would tell somebody they were reachable when they were not. See
   * `core/tailnet.ts`.
   */
  async set(input: unknown): Promise<TailnetExposure> {
    const { exposed } = setTailnetExposureInputSchema.parse(input)
    return setExposed(exposed)
  }
}
