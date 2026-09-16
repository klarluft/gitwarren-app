/**
 * `guiUrl` carries the page's token exactly when a daemon owns the page.
 *
 * Three owners, three answers. Nobody: a plain loopback link, as before. The
 * app: a plain link, because its link page is inert and needs no token. A
 * daemon: the link carries the token from the 0600 file, ahead of the
 * fragment, which is the shape the web handler exchanges for a cookie. And a
 * daemon that could not bind the port gets no token, because there is no page
 * behind the link for it to open.
 *
 * The data directory is pointed at a scratch folder before anything is
 * imported, the way the core tests do it, so the owner file, the token and
 * the instance id all land there and nothing of the developer's is touched.
 * The test's own pid is the owner's, which is what makes the owner "live".
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-gui-link-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { guiLinker } = await import('../gui-link.js')
const { clearDaemonRuntime, writeDaemonRuntime } = await import('../../core/daemon-runtime.js')
const { clearWebToken, publishWebToken } = await import('../../core/web/token.js')
const { getInstanceId } = await import('../../core/instance.js')
const { TOKEN_PARAM } = await import('../../shared/web.js')

after(() => rmSync(dataDir, { recursive: true, force: true }))

beforeEach(() => {
  clearDaemonRuntime()
  clearWebToken()
})

const tokenIn = (url: string): string | null => new URL(url).searchParams.get(TOKEN_PARAM)

test('with nobody owning the page, the link is plain loopback with the route in the fragment', () => {
  const { guiUrl } = guiLinker().review(4)

  assert.ok(guiUrl.startsWith('http://127.0.0.1:'), guiUrl)
  assert.equal(tokenIn(guiUrl), null)
  assert.ok(new URL(guiUrl).hash.startsWith('#h='), guiUrl)
})

test('with the app owning the page, the link has no token: its link page needs none', () => {
  writeDaemonRuntime({ instanceId: getInstanceId(), pid: process.pid, linkPort: 41427, owner: 'gui' })
  publishWebToken('not-for-links')

  assert.equal(tokenIn(guiLinker().review(4).guiUrl), null)
})

test('with a daemon owning the page, the link carries its token, ahead of the fragment', () => {
  writeDaemonRuntime({ instanceId: getInstanceId(), pid: process.pid, linkPort: 41427, owner: 'daemon' })
  publishWebToken('t0k3n_for-the-daemon')

  const review = guiLinker().review(4).guiUrl
  assert.equal(tokenIn(review), 't0k3n_for-the-daemon')
  assert.ok(new URL(review).hash.startsWith('#h='), review)

  // A comment link is built the same way, and lands on the line.
  const comment = guiLinker().comment({ reviewId: 4, filePath: 'src/a.ts', side: 'head', line: 3 }).guiUrl
  assert.equal(tokenIn(comment), 't0k3n_for-the-daemon')
  assert.ok(new URL(comment).hash.includes('/files/'), comment)
})

test('a daemon that could not bind the port gets no token: there is no page behind the link', () => {
  writeDaemonRuntime({ instanceId: getInstanceId(), pid: process.pid, linkPort: null, owner: 'daemon' })
  publishWebToken('unused')

  assert.equal(tokenIn(guiLinker().review(4).guiUrl), null)
})

test('the token is read per call, so a restart shows up in the next link', () => {
  writeDaemonRuntime({ instanceId: getInstanceId(), pid: process.pid, linkPort: 41427, owner: 'daemon' })
  publishWebToken('first-launch')
  assert.equal(tokenIn(guiLinker().review(4).guiUrl), 'first-launch')

  publishWebToken('second-launch')
  assert.equal(tokenIn(guiLinker().review(4).guiUrl), 'second-launch')
})
