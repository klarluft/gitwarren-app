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

test('a browsed file is a location, with or without a line', () => {
  // The browse tab shows one file at a time, so which file is part of where you
  // are - it survives a reload and can be pasted to somebody else.
  const file: Route = {
    name: 'review',
    reviewId: 4,
    tab: 'browse',
    focus: { filePath: 'src/core/git.ts' }
  }

  assert.equal(hrefFor(file), '#/reviews/4/browse/src%2Fcore%2Fgit.ts')
  assert.deepEqual(parseRoute(hrefFor(file)), file)

  // And a line in it, for a link that comes from a comment.
  const line: Route = {
    name: 'review',
    reviewId: 4,
    tab: 'browse',
    focus: { filePath: 'src/core/git.ts', side: 'head', line: 12 }
  }

  assert.equal(hrefFor(line), '#/reviews/4/browse/src%2Fcore%2Fgit.ts/head/12')
  assert.deepEqual(parseRoute(hrefFor(line)), line)
})

test('half a focus is no focus', () => {
  // A bare path is a whole destination, but segments that are present and wrong
  // mean the link was built by something that got the grammar wrong - so the
  // reader lands on the tab rather than somewhere approximate.
  const onlyTheTab = { name: 'review', reviewId: 4, tab: 'browse' }

  assert.deepEqual(parseRoute('#/reviews/4/browse/a.ts/sideways/9'), onlyTheTab)
  assert.deepEqual(parseRoute('#/reviews/4/browse/a.ts/head/0'), onlyTheTab)
  assert.deepEqual(parseRoute('#/reviews/4/browse/a.ts/head/oops'), onlyTheTab)
})

test('a focus path may not address its way out of the repository', () => {
  // The real guard is in `core/git-compare.ts`, at the read. This one keeps a
  // hash an agent wrote into a comment from becoming a location at all - and
  // since browse, a focus path is a file the screen goes and asks for.
  for (const hash of [
    '#/reviews/4/browse/..%2F..%2Fetc%2Fpasswd',
    '#/reviews/4/browse/%2Fetc%2Fpasswd',
    '#/reviews/4/browse/C%3A%5CWindows'
  ]) {
    assert.deepEqual(parseRoute(hash), { name: 'review', reviewId: 4, tab: 'browse' }, hash)
  }
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

test('the Agent Access page is a location, locally and on a host', () => {
  assert.deepEqual(parseRoute('#/agent'), { name: 'agent' })
  assert.deepEqual(parseRoute(`#/h/${HOST}/agent`), { name: 'agent', host: HOST })

  // Round trip, because M3.1's doubled `#` was a link that parsed to something
  // completely plausible rather than to nothing.
  assert.deepEqual(parseRoute(hrefFor({ name: 'agent' })), { name: 'agent' })
  assert.deepEqual(parseRoute(hrefFor({ name: 'agent', host: HOST })), {
    name: 'agent',
    host: HOST
  })
})

test('a stale link deeper than the agent page still lands on it', () => {
  assert.deepEqual(parseRoute('#/agent/anything'), { name: 'agent' })
})

test('the Hosts screen is a location, and never one on another install', () => {
  assert.deepEqual(parseRoute('#/hosts'), { name: 'hosts' })
  assert.equal(hrefFor({ name: 'hosts' }), '#/hosts')
  assert.deepEqual(parseRoute(hrefFor({ name: 'hosts' })), { name: 'hosts' })

  // A host list belongs to the install a person is driving: `hosts.*` is
  // answered locally and never forwarded, so `#/h/<id>/hosts` names a screen
  // that cannot exist. Rather than falling through to that machine's
  // repositories - where an unrecognised path lands - the segment is honoured
  // and the host is dropped, because there is one host list and this is it.
  assert.deepEqual(parseRoute(`#/h/${HOST}/hosts`), { name: 'hosts' })
})

test('a stale link deeper than the hosts page still lands on it', () => {
  assert.deepEqual(parseRoute('#/hosts/4'), { name: 'hosts' })
})
