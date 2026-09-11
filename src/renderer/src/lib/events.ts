/**
 * What a screen does when the core says something changed: ask again.
 *
 * This is the whole of the renderer's side of M6's event channel, and its
 * shortness is the design rather than an accident. An event carries a name and
 * a scope and never data (`core/events.ts`), so there is no state to apply, no
 * ordering to respect and no conflict to resolve - there is a cache key family
 * to invalidate, and SWR does the rest.
 *
 * ## Why this is not new behaviour, only earlier behaviour
 *
 * A write made in *this* window already invalidates by family:
 * `mutate(key => key.startsWith('reviews:'))` after creating a review, and the
 * same for comments. What an event does is run that same invalidation for a
 * write made somewhere else - another window, a browser tab, an agent's MCP
 * session, a person on a phone. One behaviour rather than two, which is what
 * makes it hard to get subtly wrong: if a local write refreshes the right
 * screens, a remote one now does too, by the same code path.
 *
 * And because it is only an invalidation, everything that was already true
 * stays true. The fifteen-second poll still runs; `onErrorRetry` in `main.tsx`
 * still governs a host that has gone away; `LIVE_READ_OPTIONS` reads that
 * deliberately never retry are not re-run behind anybody's back by an event
 * either, because `mutate` on a key with no subscriber does nothing at all.
 *
 * ## The host on the event is the whole of the scoping
 *
 * `scoped()` in `lib/api.ts` puts `@<instance>` on the end of every key that
 * names something a host owns, so "everything about that machine" is a suffix
 * test - which is exactly what `use-reconnect.ts` already leans on from the
 * other direction. An event from `pc-wsl` therefore refreshes `pc-wsl`'s
 * reviews and leaves this Mac's alone, and a local event refreshes the keys
 * with no suffix at all. Getting this wrong would not have been visible: the
 * screens would still be correct, just re-reading six machines' worth of SQLite
 * every time an agent typed anything.
 *
 * ## `host.state` is not the banner
 *
 * It invalidates the host list and nothing else. M4.5's banner is raised by
 * request *outcomes* in `lib/host-reachability.ts` and is deliberately left
 * alone: a request that failed is evidence about the screen in front of
 * someone, while an event is a hint that something changed somewhere. What this
 * adds is the row for a machine nobody is looking at, on the Hosts screen,
 * which had no way to learn anything until the pool had an ear.
 */
import { mutate } from 'swr'
import { RPC_EVENTS, type RpcEvent } from '@shared/rpc'
import { CACHE_KEYS, CACHE_PREFIXES } from './api'
import { eventClaimsKey } from './event-scope'

/**
 * Which key families each event invalidates.
 *
 * `comments.changed` lists the review prefix rather than a prefix of its own,
 * because threads are not a key: they arrive inside `reviews.open` under
 * `review:<id>`, which is the coarse endpoint S5 argued for. So "a comment
 * changed" and "the review changed" refresh the same thing, and the two names
 * exist because the *senders* know which they did - the distinction is worth
 * keeping on the wire even where the receiver spends it the same way.
 */
const PREFIXES_FOR_EVENT: Readonly<Record<string, readonly string[]>> = {
  [RPC_EVENTS.reviewsChanged]: [
    CACHE_PREFIXES.reviews,
    CACHE_PREFIXES.review,
    CACHE_PREFIXES.reviewCommits,
    CACHE_PREFIXES.reviewDiff
  ],
  [RPC_EVENTS.commentsChanged]: [CACHE_PREFIXES.review]
}

/**
 * Where an invalidation goes. SWR's `mutate` in the app; a spy in the test.
 *
 * A parameter rather than a module the test replaces, because what is worth
 * checking here is *which keys an event claims*, and that is a decision made
 * before SWR is involved at all. Handing the sink in makes the decision
 * observable without a cache, a provider or a React tree - the same instinct
 * that kept `lib/host-reachability.ts` free of React so its rules could be
 * tested as a node program.
 */
export type Invalidate = (matcher: string | ((key: unknown) => boolean)) => unknown

/**
 * Act on one event. Exported for the test; `startListeningForEvents` is the
 * thing the app calls.
 *
 * An unknown name is ignored rather than treated as a fault. A daemon newer
 * than this window will announce names it has not heard of, and the protocol's
 * rule has been "unknown fields are ignored" since `RPC_PROTOCOL_VERSION` was
 * written - an event is the first thing to travel in this direction, and it
 * would be a poor moment to invent a stricter rule. The cost of ignoring one is
 * fifteen seconds.
 */
export function applyEvent(event: RpcEvent, invalidate: Invalidate = mutate): void {
  if (event.event === RPC_EVENTS.hostState) {
    // One key, unscoped, because the host list is one list - see the note on
    // `CACHE_KEYS.hosts` about why there is deliberately no per-host key.
    void invalidate(CACHE_KEYS.hosts)
    return
  }

  const prefixes = PREFIXES_FOR_EVENT[event.event]
  if (!prefixes) return

  void invalidate((key: unknown) => eventClaimsKey(key, event.host, prefixes))
}

/**
 * Subscribe for the life of the window. Returns an unsubscribe.
 *
 * Installed in `main.tsx` beside the deep-link listener rather than in a
 * component, and for the same reason: it belongs to the window rather than to
 * anything React renders, and a subscription that came and went with a mount
 * would drop events during a navigation.
 */
export function startListeningForEvents(
  onEvent: (listener: (event: RpcEvent) => void) => () => void
): () => void {
  return onEvent(applyEvent)
}
