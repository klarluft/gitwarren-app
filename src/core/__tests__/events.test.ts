/**
 * The bus, and the one table that decides what is news.
 *
 * Two things are worth a test here and neither is the fan-out. The first is
 * that a *read* announces nothing: an event per `reviews.diff` would be a
 * refetch storm that looks exactly like working software until somebody opens
 * the network tab. The second is that one listener throwing does not stop the
 * others, because an emit is called from inside a write that has already
 * committed - so a broken subscriber must not turn a successful comment into a
 * failed one.
 */
import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import { emitEvent, emitForMethod, subscribeToEvents } from '../events.js'
import { RPC_EVENTS, type RpcEvent } from '../../shared/rpc.js'

const unsubscribes: (() => void)[] = []

function collect(): RpcEvent[] {
  const seen: RpcEvent[] = []
  unsubscribes.push(subscribeToEvents((event) => seen.push(event)))
  return seen
}

afterEach(() => {
  while (unsubscribes.length > 0) unsubscribes.pop()?.()
})

test('a write announces the family it changed', () => {
  const seen = collect()
  emitForMethod('comments.reply')
  assert.deepEqual(
    seen.map((event) => event.event),
    [RPC_EVENTS.commentsChanged]
  )
})

test('a read announces nothing', () => {
  const seen = collect()
  for (const method of ['reviews.open', 'reviews.diff', 'comments.list', 'hosts.list']) {
    emitForMethod(method)
  }
  assert.deepEqual(seen, [])
})

test('a method nobody has heard of announces nothing', () => {
  const seen = collect()
  emitForMethod('reviews.somethingAddedLater')
  assert.deepEqual(seen, [])
})

test('an event carries no content, only a name', () => {
  const seen = collect()
  emitForMethod('reviews.create')
  assert.equal(seen[0]?.data, null)
  // And no host: the emitter is saying "on me", and what instance id a listener
  // files that under is the listener's business. See `RpcEvent.host`.
  assert.equal(seen[0]?.host, undefined)
})

test('a listener that throws does not take its neighbours with it', () => {
  const seen: string[] = []
  unsubscribes.push(
    subscribeToEvents(() => {
      throw new Error('this subscriber is broken')
    })
  )
  unsubscribes.push(subscribeToEvents((event) => seen.push(event.event)))

  assert.doesNotThrow(() => emitEvent({ event: RPC_EVENTS.hostState, data: null }))
  assert.deepEqual(seen, [RPC_EVENTS.hostState])
})

test('unsubscribing during a fan-out does not make the loop skip the next one', () => {
  const seen: string[] = []
  const stop = subscribeToEvents(() => stop())
  unsubscribes.push(stop)
  unsubscribes.push(subscribeToEvents((event) => seen.push(event.event)))

  emitEvent({ event: RPC_EVENTS.reviewsChanged, data: null })
  assert.deepEqual(seen, [RPC_EVENTS.reviewsChanged])
})
