/**
 * Where the person was going when the link named a machine we do not have.
 *
 * ## Why this exists at all
 *
 * The recovery from an unknown host is not one screen. The card says which
 * machine is missing, the Hosts screen is where a machine gets added, and the
 * review is where the person wanted to be in the first place - three places,
 * and until M6.8 the middle one was a dead end you walked to and never came
 * back from. What has to survive that walk is one sentence: *you were trying to
 * open host X's review 4*. That sentence is this module.
 *
 * ## Why it is not in the route
 *
 * The obvious alternative is to hang the intent off the Hosts location, so the
 * URL says what the visit is for. It was rejected twice over. `routes.ts` gives
 * the hosts screen `host?: undefined` on purpose - it is the one screen that is
 * emphatically about *this* install - and threading a second machine's id
 * through it would contradict the thing that declaration is there to say. And
 * an intent is not a location: pressing Back from the Hosts screen should not
 * step through a half-finished errand, and a URL someone copies out of the
 * address bar should not carry it to somebody else.
 *
 * So it is state beside the router rather than inside it, in the same shape
 * `host-reachability.ts` uses for the same reason: a plain store with a
 * subscribe, no React in the file, so the rules are testable as a node program.
 *
 * ## Why it survives a reload
 *
 * `sessionStorage`, not memory alone. The browser shell reloads the tab for
 * reasons the person did not ask for - the token exchange in
 * `core/web/handler.ts` takes the token out of the address bar by replacing the
 * location - and an errand that evaporated on that reload would strand exactly
 * the user this feature is for. Per tab rather than per browser, because two
 * tabs open on two different machines' links are two different errands.
 *
 * Every access goes through `storage()` below and is wrapped besides, so a tab
 * with storage disabled - or a node test runner with no browser at all - keeps
 * the card and the Add button and loses only the trip back.
 *
 * ## Why it is keyed by instance id
 *
 * Because that is the only thing the link carried and the only thing that
 * identifies the machine once it connects. A host row is added with no instance
 * id at all - `hosts.add` inserts `instance_id` NULL and it is learned on the
 * first successful connect, in `recordSeen` - so "did the machine I am waiting
 * for just arrive?" cannot be asked of the row that was added. It can only be
 * asked of the id the link named, once something has connected. That is why
 * `matchPendingDestination` takes a list and looks for the id, rather than the
 * Add button simply navigating when it succeeds.
 */
import type { Route } from '@shared/routes'

const STORAGE_KEY = 'gitwarren.pending-destination'

/**
 * The two methods of `sessionStorage` this file uses, declared rather than
 * imported from the DOM library.
 *
 * The same move `lib/keys.ts` makes for a keyboard event, and for the same
 * reason: a module checked by `tsconfig.node.json` so that its rules can be
 * tested as a node program has no `lib.dom`, and pulling one in for two method
 * signatures would put the DOM back in front of every other file in that
 * project. Reached through `globalThis` so the absence of a browser is a value
 * to check rather than a name that does not resolve.
 */
interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(): SessionStorageLike | null {
  const candidate = (globalThis as { sessionStorage?: SessionStorageLike }).sessionStorage
  return candidate ?? null
}

export interface PendingDestination {
  /** The instance id the link named, which is not in the host list. */
  host: string
  /** The location to go back to, host segment and all. */
  route: Route
}

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * The in-memory copy, which is the one that is read.
 *
 * `sessionStorage` is the durable backing rather than the source of truth, so
 * a read is synchronous and cannot throw - `useSyncExternalStore` calls its
 * snapshot during render and a storage access that throws there would take the
 * screen down instead of the errand.
 */
let current: PendingDestination | null = null
let loaded = false

function read(): PendingDestination | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingDestination
    // Shape-checked rather than trusted. This is our own key in our own tab,
    // but it is also a string that survived a reload and a version change, and
    // a malformed one must not reach `navigate`.
    if (typeof parsed?.host !== 'string' || typeof parsed?.route?.name !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function write(value: PendingDestination | null): void {
  try {
    const store = storage()
    if (!store) return
    if (value === null) store.removeItem(STORAGE_KEY)
    else store.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage refused. The errand lives in memory for this page's lifetime,
    // which is the whole of it unless something reloads.
  }
}

function announce(): void {
  for (const listener of listeners) listener()
}

export function subscribeToPendingDestination(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The errand in progress, or null. */
export function pendingDestination(): PendingDestination | null {
  if (!loaded) {
    current = read()
    loaded = true
  }
  return current
}

/**
 * Remember where we were going.
 *
 * Idempotent on the same destination, because the card that calls this renders
 * on every failed revalidation and a store that announced a change each time
 * would redraw the Hosts screen on a timer.
 */
export function rememberDestination(destination: PendingDestination): void {
  const existing = pendingDestination()
  if (
    existing &&
    existing.host === destination.host &&
    JSON.stringify(existing.route) === JSON.stringify(destination.route)
  ) {
    return
  }
  current = destination
  loaded = true
  write(current)
  announce()
}

/** The errand is over, one way or the other. */
export function clearPendingDestination(): void {
  if (pendingDestination() === null) return
  current = null
  loaded = true
  write(null)
  announce()
}

/**
 * Has the machine we were waiting for turned up in this list?
 *
 * Takes the host list rather than a single row for the reason in the header:
 * the row that was just added does not know its own instance id yet, and will
 * not until something connects to it and `recordSeen` writes it down. So the
 * question is asked of the whole list, after a probe, and the answer is the
 * route to go back to.
 *
 * Returns null when there is no errand, or when the machine is still missing -
 * which is the ordinary case on a Hosts screen nobody arrived at this way.
 */
export function matchPendingDestination(
  hosts: { instanceId: string | null }[] | undefined
): PendingDestination | null {
  const destination = pendingDestination()
  if (!destination || !hosts) return null
  const found = hosts.some((host) => host.instanceId === destination.host)
  return found ? destination : null
}

/** Only for tests, which share a module instance across cases. */
export function resetPendingDestination(): void {
  current = null
  loaded = false
  write(null)
  listeners.clear()
}
