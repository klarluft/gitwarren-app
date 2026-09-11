/**
 * Which machines have stopped answering, learned from the requests this window
 * is already making to them.
 *
 * M4.5 needed a banner on an open review whose host has gone away, and the
 * obvious place to read that from is `core/hosts/pool.ts`, which has carried an
 * `onStateChange` hook since M4.1 with a comment saying this slice would render
 * it. Nothing here reads it, and the reason is worth the paragraph.
 *
 * ## A push from the pool has nowhere to travel
 *
 * `RpcEvent` in `shared/rpc.ts` is reserved for M6 and nothing emits on it. So
 * the pool's state would have to reach a screen down an Electron IPC channel
 * for the window *and* down the WebSocket for a tab - two half-built event
 * channels, in a request/response protocol, for one banner. That is the
 * argument M4.2 made when it refused to invent one for a progress bar, and it
 * is stronger here, because in this case there is already a signal.
 *
 * The signal is the reads the screen is doing anyway. An open review polls
 * `reviews.open` every fifteen seconds; when the machine goes away that read
 * fails with `HOST_OFFLINE`, and when it comes back the same read succeeds.
 * Both halves of "disconnection" are already arriving, on the one path that
 * also knows whether there is anything on screen to mark stale. What the pool
 * knows and this does not is the state of hosts nobody is looking at - which is
 * exactly the set with no screen to put a banner on.
 *
 * Polling `hosts.list` was the other candidate and is worse than either. It is
 * cheap - `hostsService.list` reads the pool rather than connecting - but the
 * pool's state only *changes* when something connects, so the poll would report
 * the past forever unless some other read were doing the real work. Two
 * questions, one answer, and a standing chance of the two disagreeing on one
 * screen.
 *
 * This is deliberately *not* where a browser tab's own dropped socket is
 * recorded, and they are not the same fact. A dead socket does not fail
 * requests - `web/carrier.ts` queues them until it reconnects - so nothing
 * settles and this file, which only ever learns from an outcome, is blind to it
 * by construction. `ShellApi.connection` is that one, and
 * `components/connection-banner.tsx` is its sentence.
 *
 * ## A request in flight is not a disconnection
 *
 * Only a settled failure marks a machine down, and only `HOST_OFFLINE` does: a
 * `NOT_FOUND` travelled the wire perfectly and is the host working correctly,
 * which is the same rule the pool applies before touching its backoff ladder.
 * The mistake in the other direction is the one `host-banner.tsx` already
 * records about a host list that has not loaded yet - the honest rendering of
 * an unanswered question is not the alarming answer.
 *
 * There is no React in this file, and that is deliberate rather than
 * incidental: the rules above are the part worth testing, and a test of them is
 * a node program (see the note about renderer tests in `tsconfig.node.json`).
 * `useSyncExternalStore` over `subscribeToHosts` is four lines at the one
 * component that needs it, which is what `connection-banner.tsx` does with the
 * other disconnection.
 */

export interface HostReachability {
  /**
   * When the current run of failures started, or null while the machine is
   * answering.
   *
   * The *first* failure of the run rather than the latest, because what a
   * banner is about is when the machine went away, and a machine that is off
   * for the evening fails every fifteen seconds without going away again.
   */
  offlineSince: number | null
  /** What the last failure said - `ssh`'s own sentence, by way of the pool. */
  message: string | null
  /**
   * When this machine last answered anything, in this window.
   *
   * Null means it has not answered since the page loaded, which is not the same
   * as never: the banner says "what was loaded" only when it has a time to name.
   */
  lastSeenAt: number | null
}

/** A machine nothing has asked anything of yet. Shared, so the snapshot is stable. */
const UNKNOWN: HostReachability = { offlineSince: null, message: null, lastSeenAt: null }

type Listener = (host: string, state: HostReachability) => void

const byHost = new Map<string, HostReachability>()
const listeners = new Set<Listener>()

function announce(host: string, state: HostReachability): void {
  for (const listener of listeners) listener(host, state)
}

/** Notified when a machine changes state. Returns an unsubscribe function. */
export function subscribeToHosts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * That machine answered.
 *
 * Called for a failure that is not a transport failure too: an error that
 * travelled the wire is proof the far end is there.
 */
export function reportHostAnswered(host: string): void {
  const current = byHost.get(host) ?? UNKNOWN
  const next: HostReachability = { offlineSince: null, message: null, lastSeenAt: Date.now() }
  byHost.set(host, next)

  // Only a change of *state* is worth waking a screen for. `lastSeenAt` moves
  // on every successful read - four times a minute on an open review, more
  // while someone is clicking - and nothing on screen shows it while the
  // machine is answering. The value is read at the moment it stops.
  //
  // The two states that *are* a change are coming back, and the very first
  // answer. The second is easy to leave out and M4.5 did, which cost the badge
  // above a freshly opened review: this window had just been served a diff by
  // the machine and went on saying "Not tried yet" about it, because the only
  // thing that would have corrected the sentence was a re-render nothing asked
  // for. Never heard from is a state, and leaving it is news.
  if (current.offlineSince !== null || current.lastSeenAt === null) announce(host, next)
}

/** That machine could not be reached, and this is what the attempt said. */
export function reportHostUnreachable(host: string, message: string): void {
  const current = byHost.get(host) ?? UNKNOWN
  const next: HostReachability = {
    offlineSince: current.offlineSince ?? Date.now(),
    message,
    lastSeenAt: current.lastSeenAt
  }
  byHost.set(host, next)
  // The message changing matters as much as the state changing, and for the
  // reason M4.1 recorded in the pool: the first thing known about a dying
  // connection is "it closed", and the sentence worth reading - "GitWarren is
  // not installed on xfor@pc-wsl" - arrives a moment later.
  if (current.offlineSince === null || current.message !== message) announce(host, next)
}

/** Forget everything. For tests; nothing in the app has any reason to. */
export function resetHostReachability(): void {
  byHost.clear()
}

/**
 * What is known about one machine.
 *
 * `UNKNOWN` for this install, which is right rather than a fallback: a local
 * call cannot be a disconnection, so there is never anything to say. The
 * returned object is the one held in the map, so it is a stable snapshot for
 * `useSyncExternalStore` between one announcement and the next.
 */
export function hostReachability(host: string | undefined): HostReachability {
  return host === undefined ? UNKNOWN : (byHost.get(host) ?? UNKNOWN)
}

/** `subscribeToHosts`, in the shape `useSyncExternalStore` wants. */
export const subscribeToHostChanges = (onStoreChange: () => void): (() => void) =>
  subscribeToHosts(() => onStoreChange())
