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
import { connectOverWebSocket } from './websocket.js'
import { connectOverWsl } from './wsl.js'
import type { HostConnection } from './carrier.js'
import { emitEvent } from '../events.js'
import { AppError } from '../../shared/errors.js'
import {
  RPC_EVENTS,
  type RpcEvent,
  type RpcMethod,
  type RpcParams,
  type RpcResult
} from '../../shared/rpc.js'

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
  kind: 'ssh' | 'wsl' | 'websocket'
  /**
   * What that carrier is handed: an `ssh` destination, a distro name, or the
   * origin of a machine that is already listening.
   */
  target: string
  /**
   * The machine's own id, once it has said it. Null until first contact.
   *
   * Carried on the route rather than looked up when needed, because the one
   * thing it is for is stamping events - and an event arrives at a moment when
   * the only thing in hand is the connection it came down. A daemon says
   * "comments changed" and means "on me"; it cannot say which row this install
   * files it under, because it may be reached by two GitWarrens at once. This
   * is the side that knows.
   *
   * Null is not a problem to solve. A host that has never answered has never
   * pushed anything either, so there is no event to be unable to tag.
   */
  instanceId?: string | null
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
  connect?: (
    route: HostRoute,
    handlers: { onClose: (error: AppError) => void; onEvent: (event: RpcEvent) => void }
  ) => HostConnection
  now?: () => number
  /**
   * Notified whenever a host's reachability changes.
   *
   * Written for M4.5's banner, unused by M4.5, and rendered at last by M6.5 -
   * and the delay is the interesting part rather than an oversight. M4.5's
   * banner is raised by request *outcomes*, in `renderer/lib/host-reachability.ts`,
   * and still is: a request that failed is evidence about the screen in front
   * of somebody, it is carrier-agnostic, and M5 proved it against `wsl.exe`
   * with no new code. None of that is replaced here.
   *
   * What this hook sees and a screen cannot is a host **nobody is looking at**,
   * and it is worth being exact about when that is a real event, because for
   * most of M4 it was not one. This pool only learns anything by *connecting*,
   * so a machine nobody was asking about was a machine nothing could say
   * anything about. What changed is `core/hosts/websocket.ts`: a listening host
   * holds an open socket with a heartbeat on it, so a machine that is switched
   * off is noticed with no request outstanding and no screen open on it. That
   * is the whole of what M6 adds to disconnection.
   *
   * The bound, recorded rather than hidden: the pool still hangs up after
   * `IDLE_TIMEOUT_MS`, so this can only speak for a host something has asked
   * about in the last ten minutes. An always-open socket to every host would be
   * a connection to every machine on the list, which is what this file exists
   * to avoid.
   */
  onStateChange?: (hostId: number, state: HostState) => void
  /**
   * An event a host pushed, tagged with which host it was.
   *
   * The pool is the only layer that can tag it. A daemon announcing
   * `comments.changed` means "on me" and has no idea what this install calls
   * it; the connection it came down is the association, and this file is what
   * holds connections.
   */
  onHostEvent?: (event: RpcEvent) => void
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
  onStateChange,
  onHostEvent
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

      entry.connection = connect(route, {
        onClose: (error) => {
          // The pipe died. Whether that is a failure depends on whether anything
          // was expecting it: a connection closed by the idle timer has already
          // been forgotten here, and must not push the host onto the backoff
          // ladder as though the machine had gone away.
          const current = entries.get(route.id)
          if (!current || current.connection === null) return
          recordFailure(route.id, current, error.message, generation)
        },
        onEvent: (event) => {
          // Stamped with the instance id from the route, which is what turns
          // "something changed" into "something changed on that machine" - and
          // is what lets the renderer invalidate one host's keys rather than
          // every host's. An untagged event would mean "this install", which
          // would be precisely wrong.
          //
          // A host that has never said who it is cannot have pushed anything,
          // so the null case is unreachable rather than handled: dropping it is
          // still the right answer if it ever happens, because an event that
          // cannot be scoped is an event that would refresh the wrong screens.
          if (!route.instanceId) return
          onHostEvent?.({ ...event, host: route.instanceId })
        }
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
 * registry: three carriers is not a number that earns indirection.
 */
function defaultConnect(
  route: HostRoute,
  handlers: { onClose: (error: AppError) => void; onEvent: (event: RpcEvent) => void }
): HostConnection {
  switch (route.kind) {
    case 'wsl':
      return connectOverWsl({ distro: route.target, ...handlers })
    case 'websocket':
      return connectOverWebSocket({ target: route.target, ...handlers })
    case 'ssh':
      return connectOverSsh({ target: route.target, ...handlers })
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
export const hostPool = createHostPool({
  // The two sources of `core/events.ts`, joined here because this is the only
  // layer that can speak for either. `host.state` is minted by this pool from a
  // connection it is holding; a host's own event arrives down that connection
  // and is tagged with the machine it came from. One bus, two sources - which
  // is the cheap answer to M4.5's objection about building two half-channels.
  //
  // `host.state` carries no data at all. What a screen does with it is
  // re-read the host list, which is one local SQLite read plus a look at this
  // pool - so putting the state on the wire would be shipping an answer the
  // receiver is about to ask for properly anyway. See `core/events.ts` on why
  // an event is never data.
  onStateChange: () => emitEvent({ event: RPC_EVENTS.hostState, data: null }),
  onHostEvent: (event) => emitEvent(event)
})
