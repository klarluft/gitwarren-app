/**
 * Coverage for the route grammar, and for the host segment M0 adds to it.
 *
 * The claim being tested is not that the new segment works - it is that adding
 * it changed nothing. Every link this app has ever written is a hash without a
 * host in it, they are stored in nothing and can arrive from anywhere, and a
 * grammar change that quietly reinterpreted one of them would be the worst
 * possible outcome of a milestone whose whole promise is "no visible change".
 * So the local cases come first and are pinned to exact strings.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOME, hrefFor, parseRoute, type Route } from '../routes.js'

const HOST = 'a1b2c3d4-0000-4000-8000-00000000beef'

// ---------------------------------------------------------------------------
// Local routes, exactly as they were before the host segment existed
// ---------------------------------------------------------------------------

test('local hrefs are the same strings they always were', () => {
  assert.equal(hrefFor({ name: 'repositories' }), '#/')
  assert.equal(hrefFor({ name: 'repository', repositoryId: 3 }), '#/repositories/3')
  assert.equal(hrefFor({ name: 'review', reviewId: 4, tab: 'files' }), '#/reviews/4/files')
  assert.equal(
    hrefFor({
      name: 'review',
      reviewId: 4,
      tab: 'files',
      focus: { filePath: 'src/main/index.ts', side: 'head', line: 94 }
    }),
    '#/reviews/4/files/src%2Fmain%2Findex.ts/head/94'
  )
})

test('a local route carries no host key at all', () => {
  // Not `host: undefined`: routes are compared for equality in the router and
  // in tests, and a key that is present but empty is not the same object.
  assert.deepEqual(parseRoute('#/reviews/4/files'), { name: 'review', reviewId: 4, tab: 'files' })
  assert.deepEqual(parseRoute('#/'), HOME)
  assert.deepEqual(parseRoute('#/repositories/3'), { name: 'repository', repositoryId: 3 })
})

test('the pre-M0 fallbacks still fall back', () => {
  assert.deepEqual(parseRoute(''), HOME)
  assert.deepEqual(parseRoute('#/nonsense'), HOME)
  assert.deepEqual(parseRoute('#/repositories/0'), HOME)
  assert.deepEqual(parseRoute('#/reviews/-2'), HOME)
  assert.deepEqual(parseRoute('#/reviews/4/nonsense'), {
    name: 'review',
    reviewId: 4,
    tab: 'conversation'
  })
})

// ---------------------------------------------------------------------------
// The host segment
// ---------------------------------------------------------------------------

test('a host is written as one segment in front of the rest', () => {
  assert.equal(hrefFor({ name: 'repositories', host: HOST }), `#/h/${HOST}/`)
  assert.equal(
    hrefFor({ name: 'repository', repositoryId: 3, host: HOST }),
    `#/h/${HOST}/repositories/3`
  )
  assert.equal(
    hrefFor({ name: 'review', reviewId: 4, tab: 'commits', host: HOST }),
    `#/h/${HOST}/reviews/4/commits`
  )
})

test('every route round-trips with and without a host', () => {
  const routes: Route[] = [
    { name: 'repositories' },
    { name: 'repositories', host: HOST },
    { name: 'repository', repositoryId: 12 },
    { name: 'repository', repositoryId: 12, host: HOST },
    { name: 'review', reviewId: 7, tab: 'conversation' },
    { name: 'review', reviewId: 7, tab: 'files', host: HOST },
    {
      name: 'review',
      reviewId: 7,
      tab: 'files',
      focus: { filePath: 'docs/Release Notes #2.md', side: 'base', line: 1 },
      host: HOST
    }
  ]

  for (const route of routes) {
    assert.deepEqual(parseRoute(hrefFor(route)), route, hrefFor(route))
  }
})

test('a file path with slashes survives the host segment', () => {
  const route: Route = {
    name: 'review',
    reviewId: 7,
    tab: 'files',
    focus: { filePath: 'src/main/index.ts', side: 'head', line: 94 },
    host: HOST
  }

  assert.equal(hrefFor(route), `#/h/${HOST}/reviews/7/files/src%2Fmain%2Findex.ts/head/94`)
  assert.deepEqual(parseRoute(hrefFor(route)), route)
})

test('a host with nothing after it is that host, at home', () => {
  assert.deepEqual(parseRoute(`#/h/${HOST}`), { name: 'repositories', host: HOST })
  assert.deepEqual(parseRoute(`#/h/${HOST}/`), { name: 'repositories', host: HOST })
})

test('a known host with an unreadable location still lands on that host', () => {
  // Losing the host here would silently send the user to the wrong machine.
  assert.deepEqual(parseRoute(`#/h/${HOST}/nonsense`), { name: 'repositories', host: HOST })
  assert.deepEqual(parseRoute(`#/h/${HOST}/reviews/0`), { name: 'repositories', host: HOST })
})

test('anything that is not an instance id is not a host', () => {
  for (const candidate of [
    'h/not-a-uuid/reviews/4',
    'h//reviews/4',
    'h/../reviews/4',
    'h/A1B2C3D4-0000-4000-8000-00000000BEEF/reviews/4', // uppercase; ids are lowercase
    `h/${HOST}x/reviews/4`
  ]) {
    assert.deepEqual(parseRoute(`#/${candidate}`), HOME, candidate)
  }
})

test('a repository id that is really a host segment is not confused for one', () => {
  // `repositories/h` was always nonsense and still is.
  assert.deepEqual(parseRoute('#/repositories/h'), HOME)
  // And a review on the local install whose *file* is called `h` is untouched.
  assert.deepEqual(parseRoute('#/reviews/4/files/h/head/2'), {
    name: 'review',
    reviewId: 4,
    tab: 'files',
    focus: { filePath: 'h', side: 'head', line: 2 }
  })
})
