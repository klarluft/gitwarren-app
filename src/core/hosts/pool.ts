/**
 * One live connection per host, and the policy about when there is one.
 *
 * `ssh.ts` knows how to open a pipe to a machine. It has no opinion about
 * *when*, and that turns out to be most of the difficulty: a connection is
 * expensive to make, wasteful to keep, and certain to break at the least
 * convenient moment. The rules are here, on their own, so they can be tested
 * with a fake connection and no network.
 *
 * ## Connect late, hang up quietly
 *
 * Nothing connects when a host is added, or when the app starts. The first
 * request opens the pipe, and ten idle minutes closes it - matching
 * `ControlPersist`, so the multiplexing master and the daemon expire together
 * rather than leaving one waiting for the other.
 *
 * "Idle" means no request has *finished* recently, not no request has started.
 * A `reviews.diff` on a large repository can outlast a naive idle timer and be
 * hung up on halfway through its own answer.
 *
 * The cost of connecting late is paid once and is small (spike S1: a warm
 * `ControlMaster` channel makes it a process spawn). The cost of connecting
 * eagerly is a laptop that wakes six SSH sessions on every login and a fan that
 * comes on when nobody asked for anything, which is precisely the impression
 * "always on, locally" was built to avoid.
 *
 * ## Backoff belongs to the host, not to the request
 *
 * A failed request fails. It is not retried - see the note in
 * `core/rpc/stdio-client.ts`, which is the decision this file is built on top
 * of. What backoff governs is how soon the *next* request is allowed to try
 * again, so that a screen polling every fifteen seconds against a machine that
 * is switched off does not spawn four `ssh` processes a minute for an hour.
 *
 * While a host is in backoff, requests fail immediately with `HOST_OFFLINE`
 * rather than waiting for a connection that is not going to succeed. Fast is
 * kinder than hopeful here: the UI can say "not reachable" now, and M4.5's
 * banner has something to render.
 *
 * It is also what bounds M4.5's retry. A screen that has gone stale asks again
 * every fifteen seconds for as long as somebody is looking at it, and four out
 * of five of those cost a rejected promise and no process. Whatever the UI
 * asks for, at most one `ssh` a minute per host actually happens.
 *
 * One deliberate exception: an explicit probe from the Hosts screen ignores the
 * backoff, because a person pressing a button has information the timer does
 * not - they just turned the machine on.
 */
import { connectOverSsh } from './ssh.js'
import { connectOverWsl } from './wsl.js'
import type { HostConnection } from './carrier.js'
import { AppError } from '../../shared/errors.js'
import type { RpcMethod, RpcParams, RpcResult } from '../../shared/rpc.js'

/**
 * How long a connection may sit unused before it is closed.
 *
 * One number, two reasons, and at M5 the second one turned out to be the more
 * interesting.
 *
 * For `ssh` it matches `ControlPersist=10m`, deliberately, so that the
 * multiplexing master and the daemon expire together rather than leaving one
 * waiting for the other.
 *
 * For `wsl.exe` there is no `ControlPersist` to keep in step with, and being
 * wrong about the number is cheap: measured on this machine, reconnecting to a
 * running distribution costs 80 ms and starting a stopped one 1.7 seconds,
 * against a key exchange for `ssh`. What makes hanging up matter here is the
 * other direction. An open pipe keeps a `serve --stdio` process alive *inside*
 * the distribution, and a distribution with a process in it is one WSL will not
 * idle down - so on `ssh` letting go retires a multiplexing master, and on WSL
 * it is what lets the whole virtual machine go to sleep. The timeout earns its
 * place more on the carrier that has no `ControlPersist`, not less.
 */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How long to refuse after a failure, by consecutive failure count.
 *
 * Quick twice, because the common failure is a laptop that has not finished
 * waking; then out of the way, because the second most common one is a machine
 * that is off for the evening. The last value repeats forever.
 */
export const BACKOFF_MS = [0, 1_000, 5_000, 15_000, 60_000] as const

export interface HostRoute {
  /** The `hosts` row id. Identity within this install, not on the network. */
  id: number
  /**
   * Which carrier reaches it. The discriminant is over *carriers*, not over
   * operating systems - what a host runs is discovered by asking it, never
   * declared. See the note on `hosts.kind` in `core/db/schema.ts`.
   */
  kind: 'ssh' | 'wsl'
  /** What that carrier is handed: an `ssh` destination, or a distro name. */
  target: string
}

export interface HostState {
  connected: boolean
  /** Consecutive failures; zero once anything succeeds. */
  failures: number
  /** Why the last attempt failed, for a screen to show. */
  lastError?: string
  /** Epoch ms before which requests fail fast. */
  retryAfter?: number
}

export interface HostPoolOptions {
  /** Swappable for tests; the default opens a real `ssh`. */
  connect?: (route: HostRoute, onClose: (error: AppError) => void) => HostConnection
  now?: () => number
  /**
   * Notified whenever a host's reachability changes. Nothing passes it yet.
   *
   * It was written for M4.5's banner and M4.5 did not use it, which is worth
   * recording rather than deleting. A push from here has nowhere to go: the
   * event channel in `shared/rpc.ts` is reserved for M6 and nothing emits on
   * it, so reaching a screen would have meant an Electron IPC channel for the
   * window *and* a WebSocket message for a tab - two half-built event channels
   * for one banner, which is the thing M4.2 refused to build for a progress
   * bar. And it was not needed: a screen already asks this machine questions,
   * so the answers it gets are the disconnection, and
   * `renderer/lib/host-reachability.ts` reads them there.
   *
   * What this hook can see that a screen cannot is a host nobody is looking at,
   * which is why it belongs to M6's `host.state` event - where a machine going
   * away is news whether or not anything is open on it.
   */
  onStateChange?: (hostId: number, state: HostState) => void
}

interface Entry {
  connection: HostConnection | null
  state: HostState
  idleTimer: NodeJS.Timeout | null
  inFlight: number
  /**
   * Which connection the state describes. Incremented every time one is opened.
   *
   * A dying connection is noticed twice - the close handler sees the pipe end,
   * and every request that was waiting on it rejects - and both of those are
   * the *same* event. Counting them separately made one failed press of "Try
   * now" advance the backoff by two rungs, so a machine that was switched off
   * went from a one-second wait to a fifteen-second one after two attempts
   * instead of four. Found against `pc-wsl` in M4.2: the pool's own tests use a
   * fake connection that rejects a request without ever closing, which is a
   * shape a real `ssh` never has.
   */
  generation: number
  /** The generation a failure has already been counted for. */
  failedGeneration: number | null
}

export interface HostPool {
  /** Ask a host something, connecting first if needed. */
  request<M extends RpcMethod>(
    route: HostRoute,
    method: M,
    params?: RpcParams<M>
  ): Promise<RpcResult<M>>
  /**
   * Reach a host on purpose, ignoring backoff, and report what happened.
   * Never throws: "unreachable, and here is why" is the answer, not a failure.
   */
  probe(route: HostRoute): Promise<HostState>
  state(hostId: number): HostState
  /** Hang up on one host, or on all of them when the app is quitting. */
  disconnect(hostId: number): void
  disconnectAll(): void
}

const OFFLINE = (message: string): AppError => new AppError('HOST_OFFLINE', message)

export function createHostPool({
  connect = defaultConnect,
  now = Date.now,
  onStateChange
}: HostPoolOptions = {}): HostPool {
  const entries = new Map<number, Entry>()

  const entryFor = (hostId: number): Entry => {
    const existing = entries.get(hostId)
    if (existing) return existing
    const created: Entry = {
      connection: null,
      state: { connected: false, failures: 0 },
      idleTimer: null,
      inFlight: 0,
      generation: 0,
      failedGeneration: null
    }
    entries.set(hostId, created)
    return created
  }

  const publish = (hostId: number, entry: Entry): void => {
    onStateChange?.(hostId, { ...entry.state })
  }

  const clearIdle = (entry: Entry): void => {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  /**
   * Start the idle clock, if nothing is in flight.
   *
   * Called when a request settles rather than when one starts, so a long answer
   * cannot be hung up on while it is still being computed.
   */
  const armIdle = (hostId: number, entry: Entry): void => {
    clearIdle(entry)
    if (entry.inFlight > 0 || !entry.connection) return
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.inFlight === 0) closeEntry(hostId, entry)
    }, IDLE_TIMEOUT_MS)
    // Node keeps the process alive for a pending timer; an idle host must not
    // be the reason a CLI refuses to exit.
    entry.idleTimer.unref?.()
  }

  const closeEntry = (hostId: number, entry: Entry): void => {
    clearIdle(entry)
    const connection = entry.connection
    entry.connection = null
    if (entry.state.connected) {
      entry.state = { ...entry.state, connected: false }
      publish(hostId, entry)
    }
    connection?.close()
  }

  /**
   * A failure moves the host along the backoff ladder, once per connection.
   *
   * `generation` is what makes it once. See the note on `Entry.generation`: the
   * end of a pipe and the rejection of what was travelling through it are one
   * event seen from two places, and only the first of them adds a rung to the
   * ladder.
   *
   * The second still replaces the message, and that is not a detail. The close
   * handler arrives first with "the connection closed", because that is all
   * that is known at the instant stdout ends; the request's own failure arrives
   * a moment later having waited for `ssh` to exit, and says "GitWarren is not
   * installed on xfor@pc-wsl". Keeping the first message because it was first
   * would undo the thing M4.1 went to some trouble to get right - so the count
   * takes the earliest and the explanation takes the latest.
   */
  const recordFailure = (
    hostId: number,
    entry: Entry,
    message: string,
    generation: number
  ): void => {
    if (entry.failedGeneration === generation) {
      if (entry.state.lastError === message) return
      entry.state = { ...entry.state, lastError: message }
      publish(hostId, entry)
      return
    }
    entry.failedGeneration = generation

    const failures = entry.state.failures + 1
    // The last rung repeats forever; `?? 0` is unreachable and is there because
    // a tuple index is not something the compiler can prove is in range.
    const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] ?? 0
    entry.state = {
      connected: false,
      failures,
      lastError: message,
      ...(wait > 0 ? { retryAfter: now() + wait } : {})
    }
    entry.connection = null
    clearIdle(entry)
    publish(hostId, entry)
  }

  const recordSuccess = (hostId: number, entry: Entry): void => {
    if (entry.state.connected && entry.state.failures === 0) return
    entry.state = { connected: true, failures: 0 }
    publish(hostId, entry)
  }

  /**
   * The connection for a host, opening one if there is none.
   *
   * `ignoreBackoff` is the probe's escape hatch; every ordinary request
   * respects the timer.
   */
  const connectionFor = (route: HostRoute, ignoreBackoff: boolean): HostConnection => {
    const entry = entryFor(route.id)

    if (entry.connection && !entry.connection.isOpen()) {
      entry.connection = null
    }

    if (!entry.connection) {
      const { retryAfter } = entry.state
      if (!ignoreBackoff && retryAfter !== undefined && now() < retryAfter) {
        throw OFFLINE(entry.state.lastError ?? `${route.target} is not reachable.`)
      }

      entry.generation += 1
      const generation = entry.generation

      entry.connection = connect(route, (error) => {
        // The pipe died. Whether that is a failure depends on whether anything
        // was expecting it: a connection closed by the idle timer has already
        // been forgotten here, and must not push the host onto the backoff
        // ladder as though the machine had gone away.
        const current = entries.get(route.id)
        if (!current || current.connection === null) return
        recordFailure(route.id, current, error.message, generation)
      })
    }

    return entry.connection
  }

  const send = async <M extends RpcMethod>(
    route: HostRoute,
    method: M,
    params: RpcParams<M> | undefined,
    ignoreBackoff: boolean
  ): Promise<RpcResult<M>> => {
    const entry = entryFor(route.id)
    const connection = connectionFor(route, ignoreBackoff)
    // Read after the connection is in hand, so it names the connection this
    // request is actually travelling on rather than whatever was there before.
    const generation = entry.generation

    entry.inFlight += 1
    try {
      const result = await connection.request(method, params)
      recordSuccess(route.id, entry)
      return result
    } catch (error) {
      const appError = AppError.from(error)
      // Only a transport failure says anything about the host. A `NOT_FOUND`
      // travelled the wire perfectly and is the host working correctly, so it
      // must not mark the machine unreachable or start a backoff.
      if (appError.code === 'HOST_OFFLINE') {
        // Awaited, because the useful half of the explanation - the exit status
        // and what `ssh` printed - lands a moment after the stream ended. See
        // `diagnostics` in `ssh.ts`.
        const detail = await connection.diagnostics()
        recordFailure(route.id, entry, detail || appError.message, generation)
        throw OFFLINE(detail || appError.message)
      }
      recordSuccess(route.id, entry)
      throw appError
    } finally {
      entry.inFlight -= 1
      armIdle(route.id, entry)
    }
  }

  return {
    request(route, method, params) {
      return send(route, method, params, false)
    },

    async probe(route) {
      try {
        // `repositories.list` is the cheapest method that proves the whole
        // stack: `ssh` authenticated, the launcher exists, Node started, SQLite
        // opened and migrated, and the protocol answered. A dedicated `ping`
        // would prove strictly less.
        await send(route, 'repositories.list', undefined, true)
      } catch {
        // Swallowed on purpose: the state carries the reason, and a probe that
        // threw would make "is this host up?" a question with an exception for
        // an answer.
      }
      return this.state(route.id)
    },

    state(hostId) {
      return { ...entryFor(hostId).state }
    },

    disconnect(hostId) {
      const entry = entries.get(hostId)
      if (entry) closeEntry(hostId, entry)
    },

    disconnectAll() {
      for (const [hostId, entry] of entries) closeEntry(hostId, entry)
    }
  }
}

/**
 * Which carrier to open, and the only place in this file that knows there is
 * more than one.
 *
 * Everything above is about *when* to connect, and none of it changed when M5
 * added a second way of reaching a machine - which is the whole argument for
 * the pool being a separate module from `ssh.ts`. A switch rather than a
 * registry: two carriers, and M6's WebSocket will be a third, is not a number
 * that earns indirection.
 */
function defaultConnect(route: HostRoute, onClose: (error: AppError) => void): HostConnection {
  switch (route.kind) {
    case 'wsl':
      return connectOverWsl({ distro: route.target, onClose })
    case 'ssh':
      return connectOverSsh({ target: route.target, onClose })
  }
}

/**
 * The pool the application uses.
 *
 * A module-level singleton for the same reason the database client is one: a
 * second pool would mean a second set of `ssh` processes to the same machines,
 * and nothing above it has any reason to want that. Tests build their own with
 * `createHostPool`.
 */
export const hostPool = createHostPool()
