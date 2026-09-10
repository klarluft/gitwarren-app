/**
 * Coverage for the deep-link parser.
 *
 * This is the one place in the app where a string written by someone else - an
 * agent's comment body, a link in a chat window - is turned into a navigation.
 * The cases that matter are therefore the hostile ones: nothing here may
 * produce a location the app does not already have, and nothing may escape into
 * a string that is later handed to a loader.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deepLinkFor,
  deepLinkPathFor,
  loopbackFragmentFor,
  LOOPBACK_HOST_PREFIX,
  parseDeepLink
} from '../deep-link.js'
import { hrefFor, type ReviewRoute } from '../routes.js'

const HOME = { name: 'repositories' } as const

test('a bare review link opens the review on its default tab', () => {
  assert.deepEqual(parseDeepLink('gitwarren://review/12'), {
    name: 'review',
    reviewId: 12,
    tab: 'conversation'
  })
})

test('a tab is carried through, and an unknown one falls back', () => {
  assert.deepEqual(parseDeepLink('gitwarren://review/12/files'), {
    name: 'review',
    reviewId: 12,
    tab: 'files'
  })
  assert.deepEqual(parseDeepLink('gitwarren://review/12/nonsense'), {
    name: 'review',
    reviewId: 12,
    tab: 'conversation'
  })
})

test('a line of the diff survives the round trip, slashes and all', () => {
  const route: ReviewRoute = {
    name: 'review',
    reviewId: 7,
    tab: 'files',
    focus: { filePath: 'src/main/index.ts', side: 'head', line: 94 }
  }

  assert.equal(deepLinkFor(route), 'gitwarren://review/7/files/src%2Fmain%2Findex.ts/head/94')
  assert.deepEqual(parseDeepLink(deepLinkFor(route)), route)
})

test('a path with a space or a hash in it comes back intact', () => {
  const route: ReviewRoute = {
    name: 'review',
    reviewId: 3,
    tab: 'files',
    focus: { filePath: 'docs/Release Notes #2.md', side: 'base', line: 1 }
  }

  assert.deepEqual(parseDeepLink(deepLinkFor(route)), route)
})

test('the scheme is matched case-insensitively, as the OS may rewrite it', () => {
  assert.deepEqual(parseDeepLink('GitWarren://REVIEW/5'), {
    name: 'review',
    reviewId: 5,
    tab: 'conversation'
  })
})

test('anything that is not a review link is ignored outright', () => {
  // The attachment host belongs to the other mechanism on this scheme, and a
  // protocol activation must never be answered from it.
  assert.equal(parseDeepLink('gitwarren://attachment/abcd.png'), null)
  assert.equal(parseDeepLink('https://example.com/review/1'), null)
  assert.equal(parseDeepLink('file:///etc/passwd'), null)
  assert.equal(parseDeepLink('javascript:alert(1)'), null)
  assert.equal(parseDeepLink(''), null)
})

test('a malformed review link lands on the home screen, never somewhere else', () => {
  for (const url of [
    'gitwarren://review',
    'gitwarren://review/',
    'gitwarren://review/../../etc/passwd',
    'gitwarren://review/0',
    'gitwarren://review/-1',
    'gitwarren://review/12abc',
    'gitwarren://review/%2e%2e%2f',
    "gitwarren://review/'><script>alert(1)</script>"
  ]) {
    assert.deepEqual(parseDeepLink(url), HOME, url)
  }
})

test('a broken focus is dropped without taking the review with it', () => {
  const onlyTheTab = { name: 'review', reviewId: 4, tab: 'files' }

  // A traversal in the file segment, a bad side, a non-numeric line, and a
  // stray percent that makes decodeURIComponent throw.
  assert.deepEqual(parseDeepLink('gitwarren://review/4/files/..%2F..%2Fetc/sideways/9'), onlyTheTab)
  assert.deepEqual(parseDeepLink('gitwarren://review/4/files/a.ts/head/0'), onlyTheTab)
  assert.deepEqual(parseDeepLink('gitwarren://review/4/files/a.ts/head/oops'), onlyTheTab)
  assert.deepEqual(parseDeepLink('gitwarren://review/4/files/%/head/2'), onlyTheTab)
})

test('a query or fragment on the URL is not part of the grammar', () => {
  assert.deepEqual(parseDeepLink('gitwarren://review/12/files?x=1#y'), {
    name: 'review',
    reviewId: 12,
    tab: 'files'
  })
})

test('the loopback fragment and the app hash describe the same place', () => {
  const route: ReviewRoute = {
    name: 'review',
    reviewId: 9,
    tab: 'commits'
  }

  // The fragment is `review/...` and the hash is `#/reviews/...`; the point is
  // that one parses back into the route the other renders.
  assert.equal(deepLinkPathFor(route), 'review/9/commits')
  assert.equal(hrefFor(route), '#/reviews/9/commits')
  assert.deepEqual(parseDeepLink(`gitwarren://${deepLinkPathFor(route)}`), route)
})

/*
 * M2: the instance id in the authority. A link now says which install the
 * review is on, so that the GitWarren the user clicks through to can tell its
 * own review 4 from another machine's review 4 - which is the whole of rule 4.
 */

const INSTANCE = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('an instance-scoped link comes back host-scoped', () => {
  assert.deepEqual(parseDeepLink(`gitwarren://${INSTANCE}/review/12/files`), {
    name: 'review',
    reviewId: 12,
    tab: 'files',
    host: INSTANCE
  })
})

test('the id survives a round trip with a focus on it', () => {
  const route: ReviewRoute = {
    name: 'review',
    reviewId: 7,
    tab: 'files',
    focus: { filePath: 'src/main/index.ts', side: 'head', line: 94 }
  }

  const url = deepLinkFor(route, INSTANCE)
  assert.equal(url, `gitwarren://${INSTANCE}/review/7/files/src%2Fmain%2Findex.ts/head/94`)
  assert.deepEqual(parseDeepLink(url), { ...route, host: INSTANCE })
})

test('a link minted before M2 still means the local install', () => {
  // The compatibility that matters: these are sitting in terminal scrollback
  // and comment bodies right now, and they have to keep meaning what they meant.
  const parsed = parseDeepLink('gitwarren://review/12/files')
  assert.deepEqual(parsed, { name: 'review', reviewId: 12, tab: 'files' })
  // Not merely absent from the comparison - absent from the object, so nothing
  // comparing routes sees a host key at all.
  assert.equal('host' in (parsed as object), false)
})

test('an authority that is neither `review` nor an instance id is not for us', () => {
  // The same answer the parser gave before instance ids existed. A near-miss id
  // is the case worth naming: one character short is not an instance id, and
  // treating it as one would mean inventing a host nothing can resolve.
  assert.equal(parseDeepLink('gitwarren://attachment/abc'), null)
  assert.equal(parseDeepLink(`gitwarren://${INSTANCE.slice(0, -1)}/review/12`), null)
  assert.equal(parseDeepLink(`gitwarren://${INSTANCE.toUpperCase()}x/review/12`), null)
})

test('an instance with something other than a review under it is not for us', () => {
  assert.equal(parseDeepLink(`gitwarren://${INSTANCE}/attachment/abc`), null)
  assert.equal(parseDeepLink(`gitwarren://${INSTANCE}/repositories/2`), null)
})

test('an instance with nothing under it is that install`s home', () => {
  // A truncated link - chat clients do this - should land somewhere real on the
  // machine it names rather than being swallowed.
  assert.deepEqual(parseDeepLink(`gitwarren://${INSTANCE}/`), {
    name: 'repositories',
    host: INSTANCE
  })
})

test('the loopback fragment is the deep link path with the id in front', () => {
  const route: ReviewRoute = { name: 'review', reviewId: 4, tab: 'conversation' }

  assert.equal(loopbackFragmentFor(INSTANCE, route), `h=${INSTANCE}/review/4/conversation`)
  // The page at the other end pastes the scheme back on, and what it produces
  // has to be the URL this module would have built itself.
  assert.equal(
    `gitwarren://${loopbackFragmentFor(INSTANCE, route).slice(LOOPBACK_HOST_PREFIX.length)}`,
    deepLinkFor(route, INSTANCE)
  )
})
