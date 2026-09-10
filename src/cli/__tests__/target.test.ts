/**
 * What `gitwarren open` puts in the address bar.
 *
 * The interesting assertions here are not "the string looks right" but
 * `parseRoute(parseDeepLink(...))` round-trips - the lesson of M3.1's doubled
 * `#`, where a URL that looked entirely plausible sent every agent link to the
 * repository list and nothing threw. A test on the literal string would have
 * passed that bug too, so the round trip is the assertion and the literal is
 * only checked where the *shape* is what matters: the mount and the token.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fragmentFor, webUrlFor } from '../target.js'
import { LOOPBACK_HOST_PREFIX, parseDeepLink } from '../../shared/deep-link.js'
import { TOKEN_PARAM, WEB_APP_MOUNT } from '../../shared/web.js'

const INSTANCE = '6f1c2a30-4b5d-4e7f-8a91-0c2d3e4f5a6b'
const DEEP_LINK = `gitwarren://${INSTANCE}/review/4/files`

/** The route a fragment means, read back the way `bootstrap.ts` reads it. */
function routeFor(fragment: string): unknown {
  const body = fragment.replace(/^#/, '')
  assert.ok(body.startsWith(LOOPBACK_HOST_PREFIX), `not a loopback fragment: ${fragment}`)
  return parseDeepLink(`gitwarren://${body.slice(LOOPBACK_HOST_PREFIX.length)}`)
}

test('no link is no fragment, which is the repository list', () => {
  assert.equal(fragmentFor(undefined), '')
  assert.equal(fragmentFor('   '), '')
})

test('a deep link survives the round trip to a fragment and back', () => {
  const fragment = fragmentFor(DEEP_LINK)
  assert.ok(fragment !== null)
  assert.deepEqual(routeFor(fragment), parseDeepLink(DEEP_LINK))
})

test('the loopback URL an agent hands out means the same thing', () => {
  const guiUrl = `http://127.0.0.1:41427/#${LOOPBACK_HOST_PREFIX}${INSTANCE}/review/4/files`
  assert.equal(fragmentFor(guiUrl), fragmentFor(DEEP_LINK))
})

test('a focused link keeps its file, side and line', () => {
  const focused = `gitwarren://${INSTANCE}/review/4/files/src%2Fmain%2Findex.ts/right/42`
  const fragment = fragmentFor(focused)
  assert.ok(fragment !== null)
  assert.deepEqual(routeFor(fragment), parseDeepLink(focused))
})

test('exactly one #, which is the bug M3.1 shipped and caught', () => {
  const fragment = fragmentFor(DEEP_LINK)
  assert.ok(fragment !== null)
  assert.equal(fragment.match(/#/g)?.length, 1)
  assert.ok(!fragment.startsWith('##'))
})

test('a link with no instance opens the local screen rather than nothing', () => {
  // The pre-M2 spelling, still in terminal scrollbacks. It carries no opinion
  // about which install the review is on, so there is nothing to put in an `h=`
  // fragment and the right landing place is where the tab already is.
  assert.equal(fragmentFor('gitwarren://review/4/files'), '')
})

test('something that is not a GitWarren link is refused, not ignored', () => {
  assert.equal(fragmentFor('https://example.com/'), null)
  assert.equal(fragmentFor('reviews/4'), null)
  assert.equal(fragmentFor('gitwarren://attachment/abc.png'), null)
})

test('the daemon serves at the root and the app one level down', () => {
  const daemon = webUrlFor('daemon', 'tok')
  const gui = webUrlFor('gui', 'tok')
  assert.equal(daemon, `http://127.0.0.1:41427/?${TOKEN_PARAM}=tok`)
  assert.equal(gui, `http://127.0.0.1:41427${WEB_APP_MOUNT}/?${TOKEN_PARAM}=tok`)
})

test('the token is escaped for a query string', () => {
  // base64url never produces one of these, and the day the token grammar
  // changes is not the day to discover the URL was assembled by concatenation.
  const url = webUrlFor('daemon', 'a+b/c=')
  assert.ok(url !== null)
  assert.ok(url.includes(`${TOKEN_PARAM}=a%2Bb%2Fc%3D`))
})

test('the query comes before the fragment', () => {
  // A fragment is not sent to the server, so a token after the `#` would be a
  // page that loads and then refuses itself.
  const url = webUrlFor('daemon', 'tok', DEEP_LINK)
  assert.ok(url !== null)
  assert.ok(url.indexOf(`?${TOKEN_PARAM}=`) < url.indexOf('#'))
})

test('an unrecognised link is null all the way up, not a home page', () => {
  assert.equal(webUrlFor('daemon', 'tok', 'https://example.com/'), null)
})
