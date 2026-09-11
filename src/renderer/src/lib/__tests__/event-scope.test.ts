/**
 * Which cache keys an event is news about.
 *
 * The subtle half of the renderer's event handling is not the fan-out, it is
 * the *scope*. An event from `pc-wsl` must refresh `pc-wsl`'s keys and leave
 * this Mac's alone, and getting that wrong would not have been visible on any
 * screen: everything would still be correct, just re-reading every machine's
 * SQLite whenever an agent typed anything. That is the kind of wrong a test is
 * for and a demonstration is not, which is why the rule lives in a module with
 * no imports and this file exists next to it.
 *
 * The prefixes are written out here rather than read from `CACHE_PREFIXES`,
 * because `lib/api.ts` throws at import time without `window.gitwarren` - see
 * the header of `lib/event-scope.ts`. They are a handful of literals whose
 * exact spelling is the thing under test anyway.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { eventClaimsKey, keyBelongsTo } from '../event-scope'

const HOST = '4e0b0adb00004000800000000000abcd'
const OTHER = 'aaaaaaaa00004000800000000000bbbb'
const REVIEWS = ['reviews:', 'review:', 'review-commits:', 'review-diff:']

test('a key with no host is this install’s own', () => {
  assert.equal(keyBelongsTo('review:4', undefined), true)
  assert.equal(keyBelongsTo(`review:4@${HOST}`, undefined), false)
})

test('a key belongs to the machine named on its end, and to no other', () => {
  assert.equal(keyBelongsTo(`review:4@${HOST}`, HOST), true)
  assert.equal(keyBelongsTo(`review:4@${OTHER}`, HOST), false)
  assert.equal(keyBelongsTo('review:4', HOST), false)
})

test('an event from a host claims that host’s reviews and nothing local', () => {
  const claimed = [
    'reviews:all:any',
    `reviews:all:any@${HOST}`,
    'review:4',
    `review:4@${HOST}`,
    `review-diff:4:all@${HOST}`,
    `review:4@${OTHER}`
  ].filter((key) => eventClaimsKey(key, HOST, REVIEWS))

  assert.deepEqual(claimed, [
    `reviews:all:any@${HOST}`,
    `review:4@${HOST}`,
    `review-diff:4:all@${HOST}`
  ])
})

test('a local event leaves every host’s keys alone', () => {
  const claimed = ['reviews:all:any', 'review:4', `review:4@${HOST}`].filter((key) =>
    eventClaimsKey(key, undefined, REVIEWS)
  )
  assert.deepEqual(claimed, ['reviews:all:any', 'review:4'])
})

test('a family nobody named is not claimed, however close the spelling', () => {
  // `repositories` and `app-info` are not in the reviews family, and
  // `reviewed-somethings` would be a new key rather than a `review:` one - the
  // prefixes carry their separator for exactly this reason.
  for (const key of ['repositories', 'app-info', 'hosts', 'editors']) {
    assert.equal(eventClaimsKey(key, undefined, REVIEWS), false, key)
  }
})

test('a key that is not a string is never claimed', () => {
  // SWR keys may be arrays or objects. This app uses strings throughout, and a
  // predicate that assumed so would throw inside `mutate` rather than say no.
  for (const key of [null, undefined, 4, ['review:4'], { key: 'review:4' }]) {
    assert.equal(eventClaimsKey(key, undefined, REVIEWS), false)
  }
})
