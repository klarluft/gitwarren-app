/**
 * One bus, two sources, and nothing on it that anybody could mistake for data.
 *
 * Everything in this application has been request/response since M1, and that
 * was right: a screen asks a question and gets an answer, and the answer is the
 * only thing it believes. M6 adds the one message that travels the other way -
 * not because a screen needs pushing at, but because of the thing a screen
 * cannot see. `core/hosts/pool.ts` knows when a machine nobody is looking at
 * goes away, and until now that knowledge had nowhere to go; M4.5 wrote the
 * refusal down rather than build half a channel for it.
 *
 * ## What an event is allowed to carry, and why it is one rule rather than two
 *
 * A name, and a scope. Never data.
 *
 * This is the same rule as "a lost request is never retried" in
 * `core/rpc/stdio-client.ts`, which is worth seeing, because a person who holds
 * one idea will get the next case right and a person holding two rules will
 * not. The idea is that **a message may never stand in for the asking side's
 * own knowledge.** A retry decides, for the caller, what a missing answer meant
 * - and cannot know, so for `comments.reply` it guesses wrong by posting a
 * second comment. An event carrying data decides, for the screen, that the push
 * and the database agree - and cannot know that either, because the push
 * crossed a network that drops, reorders and duplicates while the database is
 * the thing that is actually true.
 *
 * So what arrives is a reason to re-ask, and the answer still comes from a
 * read. Two properties fall out of that and both are the reason it is safe:
 *
 *  - **A lost event costs latency, never correctness.** Which is what makes the
 *    fifteen-second poll a real fallback rather than a story told about one.
 *    Events are additive here in the strict sense: delete this file and the
 *    application is M5, slower.
 *  - **A duplicate or out-of-order event is harmless.** There is no state to
 *    apply in the wrong order, only a key to invalidate twice.
 *
 * ## Why `host.state` and `reviews.changed` are one channel
 *
 * They are two facts with two owners. `host.state` is about a machine and is
 * known only to this install's pool; `reviews.changed` is about data and is
 * known only to the machine that owns it. M4.5 objected to "two half-built
 * event channels", and the answer is not to build one of them - it is that at
 * the far end they do the identical thing, which is invalidate a family of
 * cache keys. So there is one bus with two sources: the pool emits onto it
 * directly, and an `RpcEvent` arriving from a host is re-emitted onto it tagged
 * with the host it came from. One subscription drains it.
 *
 * ## Deliberately not an EventEmitter
 *
 * A `Set` of listeners and a `for` loop. Node's `EventEmitter` would bring
 * per-name subscription, which is the one thing no subscriber here wants - both
 * sinks (`core/rpc/websocket.ts` and `main/ipc.ts`) forward everything - and an
 * `error` event whose special-case semantics would be a trap in a module where
 * a throwing listener must not take the emitter down with it.
 *
 * Free of Electron and of `ws`, like every other file in `core/`: the bus is
 * emitted onto by the dispatcher and by the pool, and read by a WebSocket
 * server, an Electron main process and a stdio daemon. None of them may be the
 * one the others import.
 */
import { RPC_EVENTS, type RpcEvent, type RpcEventName } from '../shared/rpc.js'

type Listener = (event: RpcEvent) => void

const listeners = new Set<Listener>()

/**
 * Hear everything that happens on this install. Returns an unsubscribe.
 *
 * Every sink takes the lot rather than naming events it cares about. There are
 * three names, every sink forwards all three, and a filter would be a list to
 * keep in step with `RPC_EVENTS` for no benefit - the decision about what an
 * event *means* belongs at the end of the wire, in the renderer, where the
 * cache keys are.
 */
export function subscribeToEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Announce that something changed.
 *
 * Synchronous and never throws. A listener that fails is logged and the rest
 * still run, because the alternative is one broken socket stopping a window
 * from learning about a comment - and an emit is called from inside a write
 * that has already succeeded, so raising here would report a failure for
 * something that worked.
 *
 * The listener set is copied before iterating: a sink that unsubscribes while
 * being notified is ordinary (a socket closing during a fan-out) and must not
 * make the loop skip its neighbour.
 */
export function emitEvent(event: RpcEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error(`[events] a listener failed on ${event.event}`, error)
    }
  }
}

/**
 * Which event a method that just succeeded is news about, or null for a read.
 *
 * A table rather than a guess from the method name, for the same reason
 * `READ_METHODS` is a list somebody maintains: the cost of being wrong is
 * silent in both directions - a missing entry is a screen that waits fifteen
 * seconds, an extra one is a refetch nobody needed - and neither shows up in a
 * type error.
 *
 * Deliberately coarse. `comments.reply` names a thread and `comments.remove`
 * names a comment, so deriving "review 4" from the params would mean three
 * lookups against a database in the one place that must not fail after a write
 * has already committed. It does not need to: the renderer's own writes already
 * invalidate by family (see `CACHE_PREFIXES` in `renderer/lib/api.ts`), so an
 * event doing exactly what a local write does is one behaviour rather than two.
 * The extra cost is one indexed SQLite read on a screen that is open.
 *
 * `reviews.setFileReviewed` is here even though it is a mark rather than
 * content, because two windows on one machine are two people's view of the same
 * checklist - and it is *not* reachable over MCP at all, deliberately, so the
 * only way it fires is a person ticking a box.
 */
const EVENT_FOR_METHOD: Readonly<Record<string, RpcEventName>> = {
  'reviews.create': RPC_EVENTS.reviewsChanged,
  'reviews.update': RPC_EVENTS.reviewsChanged,
  'reviews.remove': RPC_EVENTS.reviewsChanged,
  'reviews.setFileReviewed': RPC_EVENTS.reviewsChanged,
  'repositories.add': RPC_EVENTS.reviewsChanged,
  'repositories.update': RPC_EVENTS.reviewsChanged,
  'repositories.remove': RPC_EVENTS.reviewsChanged,
  'comments.createThread': RPC_EVENTS.commentsChanged,
  'comments.reply': RPC_EVENTS.commentsChanged,
  'comments.update': RPC_EVENTS.commentsChanged,
  'comments.remove': RPC_EVENTS.commentsChanged,
  'comments.setResolved': RPC_EVENTS.commentsChanged
}

/**
 * Announce a method that just wrote something, if it is one.
 *
 * Called from `core/rpc/dispatcher.ts` after the work succeeded, which is the
 * one place every human-driven write passes through. Agents do not come through
 * there - the MCP server imports the services directly, which is how
 * `HUMAN_AUTHOR` stays honest - so the agent side announces itself from its own
 * process. See `mcp/poke.ts`.
 *
 * `hosts.*` is absent from the table on purpose. A host row changing is a fact
 * about this install's list, the screen that changed it is the screen that
 * asked, and `host.state` covers the half nobody is looking at.
 */
export function emitForMethod(method: string): void {
  const event = EVENT_FOR_METHOD[method]
  if (event) emitEvent({ event, data: null })
}
