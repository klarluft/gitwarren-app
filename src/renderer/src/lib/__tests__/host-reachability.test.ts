/**
 * The rules a banner is drawn from, without a banner.
 *
 * Everything here is about telling three states apart that a screen is very
 * likely to blur: never asked, answering, and gone. The first two look the same
 * in a naive store - both are "no error" - and getting that wrong is how a host
 * that is perfectly fine announces itself as unreachable for the first frames
 * of a load, which `host-banner.tsx` has a paragraph about.
 */
import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import {
  hostReachability,
  reportHostAnswered,
  reportHostUnreachable,
  resetHostReachability,
  subscribeToHosts
} from '../host-reachability'

const HOST = 'a4f0c5f0-0000-4000-8000-000000000001'

afterEach(() => resetHostReachability())

test('a machine nothing has asked about is not reported as gone', () => {
  const state = hostReachability(HOST)
  assert.equal(state.offlineSince, null)
  assert.equal(state.message, null)
  assert.equal(state.lastSeenAt, null)
})

test('this install is never a disconnection', () => {
  assert.equal(hostReachability(undefined).offlineSince, null)
})

test('a failure carries the sentence the attempt produced', () => {
  reportHostUnreachable(HOST, 'ssh could not connect to xfor@pc-wsl.')
  const state = hostReachability(HOST)
  assert.ok(state.offlineSince !== null)
  assert.equal(state.message, 'ssh could not connect to xfor@pc-wsl.')
})

test('a run of failures is one going away, and takes the later explanation', () => {
  reportHostUnreachable(HOST, 'The connection to the host closed.')
  const first = hostReachability(HOST).offlineSince
  reportHostUnreachable(HOST, 'GitWarren is not installed on xfor@pc-wsl.')

  const state = hostReachability(HOST)
  // The moment it went away, not the moment of the latest attempt: a machine
  // that is off for the evening fails every fifteen seconds without going away
  // again. The message is the opposite - the useful half of a failure arrives
  // after the failure, which is what M4.1 built `diagnostics()` for.
  assert.equal(state.offlineSince, first)
  assert.equal(state.message, 'GitWarren is not installed on xfor@pc-wsl.')
})

test('an answer clears it, and is what a screen is woken for', () => {
  const seen: (number | null)[] = []
  const unsubscribe = subscribeToHosts((_host, state) => seen.push(state.offlineSince))

  reportHostUnreachable(HOST, 'ssh could not connect to xfor@pc-wsl.')
  reportHostAnswered(HOST)

  assert.equal(hostReachability(HOST).offlineSince, null)
  assert.equal(hostReachability(HOST).message, null)
  // Once for going, once for coming back. Anything else would be a refetch per
  // request; see `use-reconnect.ts`, which revalidates a whole machine on this.
  assert.equal(seen.length, 2)
  assert.equal(seen[1], null)
  unsubscribe()
})

test('coming back after a first answer is still one announcement', () => {
  reportHostAnswered(HOST)

  let woken = 0
  const unsubscribe = subscribeToHosts(() => {
    woken += 1
  })
  reportHostUnreachable(HOST, 'ssh could not connect to xfor@pc-wsl.')
  reportHostAnswered(HOST)
  reportHostAnswered(HOST)

  assert.equal(woken, 2)
  unsubscribe()
})

test('the first answer is news, and every one after it is not', () => {
  let woken = 0
  const unsubscribe = subscribeToHosts(() => {
    woken += 1
  })

  reportHostAnswered(HOST)
  reportHostAnswered(HOST)
  reportHostAnswered(HOST)

  // Once: leaving "never heard from" is a state change, and the badge above a
  // review depends on hearing about it. The two after it are not - a screen
  // that redrew on every successful read would redraw on every read.
  assert.equal(woken, 1)
  assert.ok(hostReachability(HOST).lastSeenAt !== null)
  unsubscribe()
})

test('when the machine last answered survives it going away', () => {
  reportHostAnswered(HOST)
  const seen = hostReachability(HOST).lastSeenAt
  reportHostUnreachable(HOST, 'ssh could not connect to xfor@pc-wsl.')

  // This is the number the banner names - "showing what was loaded at 14:32" -
  // so it has to be the last time the machine spoke, not the last time it was
  // asked.
  assert.equal(hostReachability(HOST).lastSeenAt, seen)
})

test('machines are kept apart', () => {
  const other = 'a4f0c5f0-0000-4000-8000-000000000002'
  reportHostUnreachable(HOST, 'ssh could not connect to xfor@pc-wsl.')

  assert.ok(hostReachability(HOST).offlineSince !== null)
  assert.equal(hostReachability(other).offlineSince, null)
})
