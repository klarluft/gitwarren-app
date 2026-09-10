/**
 * Coverage for the link an agent hands out, as a browser tab reads it.
 *
 * This is the one piece of M3 with a bug already to its name: the translated
 * route was being written back with a `#` that `hrefFor` had already supplied,
 * so the hash became `##/reviews/2/files`, `parseRoute` saw a first segment of
 * `#`, and every link quietly opened the repository list instead of the review.
 * Nothing threw, nothing was logged, and the screen it landed on is a
 * completely plausible one - which is exactly why the round trip below asserts
 * on `parseRoute(hrefFor(...))` rather than on the route alone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLoopbackFragment, routeForLoopbackFragment } from '../loopback-fragment.js'
import { hrefFor, parseRoute } from '../../shared/routes.js'

const OURS = '22f2aac3-13f1-4f94-a180-35803e32ef61'
const THEIRS = '11111111-1111-4111-8111-111111111111'

test('an ordinary app hash is not a loopback fragment and is left alone', () => {
  assert.equal(isLoopbackFragment('#/reviews/2/files'), false)
  assert.equal(routeForLoopbackFragment('#/reviews/2/files', OURS), null)
})

test("a link for this install becomes that install's own local route", () => {
  const route = routeForLoopbackFragment(`#h=${OURS}/review/2/files`, OURS)

  assert.deepEqual(route, { name: 'review', reviewId: 2, tab: 'files' })
  // No host key at all, rather than one set to undefined.
  assert.ok(route && !('host' in route))
})

test('the translated route survives being written back out and read again', () => {
  // The regression that started this file. `hrefFor` already begins with `#`.
  const route = routeForLoopbackFragment(`#h=${OURS}/review/2/files`, OURS)
  const href = hrefFor(route!)

  assert.equal(href, '#/reviews/2/files')
  assert.deepEqual(parseRoute(href), { name: 'review', reviewId: 2, tab: 'files' })
})

test('a file path with slashes in it survives the round trip', () => {
  const fragment = `#h=${OURS}/review/2/files/${encodeURIComponent('src/core/web/handler.ts')}/head/42`
  const route = routeForLoopbackFragment(fragment, OURS)

  assert.deepEqual(parseRoute(hrefFor(route!)), {
    name: 'review',
    reviewId: 2,
    tab: 'files',
    focus: { filePath: 'src/core/web/handler.ts', side: 'head', line: 42 }
  })
})

test("a link for another install does not open this one's review of that number", () => {
  // The failure this rule exists to prevent: review ids are per host, so
  // honouring the number would show the wrong review with no sign of it.
  const route = routeForLoopbackFragment(`#h=${THEIRS}/review/2/files`, OURS)

  assert.deepEqual(route, { name: 'repositories' })
})

test('a fragment addressed to us but malformed inside lands somewhere harmless', () => {
  const route = routeForLoopbackFragment(`#h=${OURS}/nonsense/here`, OURS)

  assert.deepEqual(route, { name: 'repositories' })
})

test('a fragment with no instance id at all is the pre-M2 form, and is local', () => {
  const route = routeForLoopbackFragment('#h=review/2/files', OURS)

  assert.deepEqual(parseRoute(hrefFor(route!)), { name: 'review', reviewId: 2, tab: 'files' })
})
