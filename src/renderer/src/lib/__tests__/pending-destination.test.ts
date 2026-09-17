/**
 * The errand that survives the walk to the Hosts screen.
 *
 * Tested as a node program, which is why `pending-destination.ts` has no React
 * in it - the same bargain `host-reachability.ts` struck for the same reason.
 * There is no `window` here at all, and that is not a gap in the test: every
 * storage access in the module is wrapped precisely so that a tab with storage
 * disabled keeps the card and the Add button and loses only the return trip.
 * Running with no `window` exercises that path on every case.
 *
 * What is worth asserting is the matching rule, because it is the part that is
 * easy to get subtly wrong and impossible to see going wrong: a host row is
 * added with `instance_id` NULL and learns its id one connect later, so a
 * match on "we added something" rather than "the id turned up" would offer the
 * way back to a review on whatever machine happened to be added next.
 */
import { strict as assert } from 'node:assert'
import { beforeEach, test } from 'node:test'
import {
  clearPendingDestination,
  matchPendingDestination,
  pendingDestination,
  rememberDestination,
  resetPendingDestination,
  subscribeToPendingDestination
} from '../pending-destination'
import type { Route } from '../../../../shared/routes'

const HOST = '4e0b0adb-0000-4000-8000-00000000abcd'
const OTHER = 'aaaaaaaa-0000-4000-8000-00000000bbbb'
const ROUTE: Route = { name: 'review', reviewId: 4, tab: 'conversation', host: HOST }

beforeEach(() => {
  resetPendingDestination()
})

test('there is no errand until a failed link sets one', () => {
  assert.equal(pendingDestination(), null)
})

test('an errand is remembered whole, host and route together', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  assert.deepEqual(pendingDestination(), { host: HOST, route: ROUTE })
})

test('clearing ends it', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  clearPendingDestination()
  assert.equal(pendingDestination(), null)
})

test('remembering the same errand twice announces nothing', () => {
  let announcements = 0
  subscribeToPendingDestination(() => {
    announcements += 1
  })

  rememberDestination({ host: HOST, route: ROUTE })
  assert.equal(announcements, 1)

  // The card re-renders on every failed revalidation and calls this each time.
  // A store that announced on each would redraw the Hosts screen on a timer.
  rememberDestination({ host: HOST, route: { ...ROUTE } })
  assert.equal(announcements, 1)

  rememberDestination({ host: HOST, route: { ...ROUTE, tab: 'files' } })
  assert.equal(announcements, 2)
})

test('clearing an errand that is not there announces nothing either', () => {
  let announcements = 0
  subscribeToPendingDestination(() => {
    announcements += 1
  })
  clearPendingDestination()
  assert.equal(announcements, 0)
})

test('a subscriber can leave', () => {
  let announcements = 0
  const unsubscribe = subscribeToPendingDestination(() => {
    announcements += 1
  })
  unsubscribe()
  rememberDestination({ host: HOST, route: ROUTE })
  assert.equal(announcements, 0)
})

test('nothing matches while there is no errand', () => {
  assert.equal(matchPendingDestination([{ instanceId: HOST }]), null)
})

test('nothing matches while the host list is still on its way', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  assert.equal(matchPendingDestination(undefined), null)
})

test('a row that has not learned its id yet is not the machine we are waiting for', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  // Exactly what `hosts.add` returns: the row exists, the id does not. The
  // errand must stay open until a probe writes the real id down.
  assert.equal(matchPendingDestination([{ instanceId: null }]), null)
})

test('another machine turning up is not the one the link named', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  assert.equal(matchPendingDestination([{ instanceId: OTHER }]), null)
})

test('the errand is matched once the id the link carried is in the list', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  const matched = matchPendingDestination([{ instanceId: null }, { instanceId: HOST }])
  assert.deepEqual(matched, { host: HOST, route: ROUTE })
})

test('matching does not end the errand; only navigating or dismissing does', () => {
  rememberDestination({ host: HOST, route: ROUTE })
  matchPendingDestination([{ instanceId: HOST }])
  assert.deepEqual(pendingDestination(), { host: HOST, route: ROUTE })
})
