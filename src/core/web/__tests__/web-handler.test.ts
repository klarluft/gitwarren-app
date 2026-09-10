/**
 * Coverage for the loopback gate and the file server behind it.
 *
 * The renderer is not what is under test here - it is the same renderer the
 * window runs, and M1 is what makes that true. What is new in M3, and what
 * these tests are about, is that a port on this machine now answers with
 * repositories and comments instead of one inert page. Every case below is a
 * way that port could be reached by something the user did not point at it:
 * a page on another origin, a name that resolves to 127.0.0.1, a URL from a
 * previous launch, a path with `..` in it.
 *
 * The last test is the one that says the whole thing works: a WebSocket, a
 * request over it, and a real answer from the real dispatcher against a real
 * database. If that passes, a browser tab is a GitWarren.
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocket } from 'ws'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-web-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { createWebHandler } = await import('../handler.js')
const { SESSION_COOKIE, TOKEN_PARAM, WEB_PATHS, webAttachmentSrc } = await import(
  '../../../shared/web.js'
)
const { attachmentsService } = await import('../../services/attachments.js')
const { closeDatabase } = await import('../../db/client.js')

const MOUNT = '/app/'
const TOKEN = 'a-test-token-that-is-long-enough'

/** A web build, in the smallest form the server can tell apart from nothing. */
const staticRoot = mkdtempSync(join(tmpdir(), 'gitwarren-web-build-'))
mkdirSync(join(staticRoot, 'assets'))
writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>GitWarren</title>')
writeFileSync(join(staticRoot, 'assets', 'main.js'), 'export const app = 1\n')

const APP_INFO = {
  version: '0.0.0-test',
  instanceId: '00000000-0000-4000-8000-000000000000',
  platform: process.platform,
  packaged: false,
  dataDirectory: dataDir,
  databasePath: join(dataDir, 'gitwarren.db'),
  linkPort: null,
  mcp: {
    command: '/nowhere/gitwarren-mcp',
    args: [],
    env: {},
    available: false,
    stable: true,
    direct: { command: '/nowhere/gitwarren-mcp', args: [], env: {} }
  }
}

let server: Server
let port = 0
let handler: ReturnType<typeof createWebHandler>

before(async () => {
  handler = createWebHandler({
    mount: MOUNT,
    staticRoot,
    token: TOKEN,
    appInfo: () => APP_INFO,
    // The real port is fixed at 41427 and is very likely held by the developer's
    // own GitWarren, so the handler is told which authority it is answering on.
    port: 0
  })

  server = createServer((request, response) => {
    if (!handler.request(request, response)) response.writeHead(404).end()
  })
  server.on('upgrade', (request, socket, head) => {
    if (!handler.upgrade(request, socket, head)) socket.destroy()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0

  // The handler was built before the port was known, which is the one thing a
  // test can do that neither shell does. Rebuilt now that it is.
  handler.close()
  handler = createWebHandler({
    mount: MOUNT,
    staticRoot,
    token: TOKEN,
    appInfo: () => APP_INFO,
    port
  })
})

after(async () => {
  handler.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(staticRoot, { recursive: true, force: true })
})

function origin(): string {
  return `http://127.0.0.1:${port}`
}

/** A request that carries a valid session, as a browser would after the swap. */
function withSession(headers: Record<string, string> = {}): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${TOKEN}`, ...headers }
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin()}${path}`, { headers, redirect: 'manual' })
}

/**
 * A GET with headers exactly as given, `Host` included.
 *
 * `fetch` cannot do this: `Host` is a forbidden header name, so undici silently
 * drops an override and the request arrives naming the real authority. That is
 * the correct behaviour for a browser and useless for testing the one check
 * that exists because a *browser* is what sends the header - hence the raw
 * client for this case.
 */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
    request.on('error', reject)
    request.end()
  })
}

test('a Host that is not the loopback authority is refused', async () => {
  // What a DNS rebinding attack looks like from this side: the connection is on
  // 127.0.0.1, and the browser still names the site it thinks it is talking to.
  const status = await rawGet(MOUNT, withSession({ Host: 'evil.example' }))

  assert.equal(status, 403)
})

test('the same request naming the real authority is served', async () => {
  // The pair matters: without it the test above would pass just as well against
  // a server that refused everything.
  const status = await rawGet(MOUNT, withSession({ Host: `127.0.0.1:${port}` }))

  assert.equal(status, 200)
})

test('a page on another origin is refused even with a session', async () => {
  const response = await get(`${MOUNT}`, withSession({ origin: 'http://evil.example' }))

  assert.equal(response.status, 403)
})

test('a navigation, which carries no Origin at all, is not refused for that', async () => {
  const response = await get(`${MOUNT}`, withSession())

  assert.equal(response.status, 200)
})

test('a write method is refused before anything else is considered', async () => {
  const response = await fetch(`${origin()}${MOUNT}`, {
    method: 'POST',
    headers: withSession({ origin: origin() })
  })

  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, HEAD')
})

test('no session is 401 and a page that says how to get one', async () => {
  const response = await get(MOUNT)
  const body = await response.text()

  assert.equal(response.status, 401)
  assert.match(body, /needs its token/)
  // The page must not be a way to learn the answer it is asking for.
  assert.ok(!body.includes(TOKEN))
})

test('a token in the URL is exchanged for a cookie and taken back out', async () => {
  const response = await get(`${MOUNT}?${TOKEN_PARAM}=${TOKEN}`)

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), MOUNT)

  const cookie = response.headers.get('set-cookie') ?? ''
  assert.match(cookie, new RegExp(`${SESSION_COOKIE}=${TOKEN}`))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Path=\//)
})

test('a token from a previous launch is refused', async () => {
  const response = await get(`${MOUNT}?${TOKEN_PARAM}=an-old-token-of-the-same-len`)

  assert.equal(response.status, 403)
})

test('the mount without its trailing slash redirects rather than serving', async () => {
  // Asset URLs in the build are relative, so a document served at `/app` would
  // send the browser looking for `/assets/…` one level too high.
  const response = await get('/app', withSession())

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), MOUNT)
})

test('the document is served, and never cached', async () => {
  const response = await get(MOUNT, withSession())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
})

test('a hashed asset is served as immutable', async () => {
  const response = await get(`${MOUNT}assets/main.js`, withSession())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /javascript/)
  assert.match(response.headers.get('cache-control') ?? '', /immutable/)
})

test('a missing asset is a 404 and not the document', async () => {
  // Answering HTML under a `.js` name is how a blank page with a baffling
  // console error happens.
  const response = await get(`${MOUNT}assets/not-here.js`, withSession())

  assert.equal(response.status, 404)
})

test('a path that is not a file falls back to the document', async () => {
  const response = await get(`${MOUNT}anything/at/all`, withSession())

  assert.equal(response.status, 200)
  assert.match(await response.text(), /GitWarren/)
})

test('a traversal out of the web build is refused however it is spelled', async () => {
  // Encoded, so the URL parser does not normalise it away before it arrives -
  // which is exactly why the confinement is checked on the resolved path
  // rather than on the text of the request.
  const response = await get(`${MOUNT}%2e%2e%2f%2e%2e%2fetc%2fpasswd`, withSession())

  assert.equal(response.status, 403)
})

test('app-info describes this install, to a session and to nobody else', async () => {
  const anonymous = await get(WEB_PATHS.appInfo)
  assert.equal(anonymous.status, 401)

  const response = await get(WEB_PATHS.appInfo, withSession())
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), APP_INFO)
})

test('an unknown path under the shell prefix is a 404, not the document', async () => {
  const response = await get('/gitwarren/nothing-here', withSession())

  assert.equal(response.status, 404)
})

/* -------------------------------------------------------------------------- */
/* Attachments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The half of M3.2 that has a URL.
 *
 * A comment body holds `gitwarren://attachment/<sha>.<ext>`, which the window
 * serves over a custom scheme and a tab cannot. These tests are about the HTTP
 * form of the same store, and the case that matters most is the last one: the
 * name in that URL comes out of a comment body, comment bodies are written by
 * agents, and an agent may have just read untrusted content out of the
 * repository under review.
 */

/** A 1x1 PNG, the smallest thing that is really an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

test('an attachment is served to a session, and to nobody else', async () => {
  const stored = await attachmentsService.ingest({ bytes: PNG, originalName: 'shot.png' })
  const path = webAttachmentSrc(stored.url)

  // The rewrite the browser shell does, asserted here rather than trusted: the
  // string the renderer puts in an `<img src>` is the one this server routes on.
  assert.equal(path, `${WEB_PATHS.attachments}${stored.sha}.png`)

  const anonymous = await get(path)
  assert.equal(anonymous.status, 401)

  const response = await get(path, withSession())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  // Content-addressed: the name is the hash of the bytes, so they cannot change.
  assert.match(response.headers.get('cache-control') ?? '', /immutable/)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)
})

test('a token whose bytes are gone is a 404 rather than a broken stream', async () => {
  // What the sweep leaves behind: a body still refers to an image nobody kept.
  const response = await get(`${WEB_PATHS.attachments}${'a'.repeat(64)}.png`, withSession())

  assert.equal(response.status, 404)
})

test('a name that is not a hash and an extension never reaches the filesystem', async () => {
  // Encoded, so nothing normalises it away before it arrives. The defence is
  // the whitelist rather than a traversal filter, so each of these fails on
  // being read rather than on where it resolved to.
  for (const name of [
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    `${'a'.repeat(64)}.png%2f..%2f..%2fetc%2fpasswd`,
    `${'A'.repeat(64)}.png`,
    `${'a'.repeat(63)}.png`
  ]) {
    const response = await get(`${WEB_PATHS.attachments}${name}`, withSession())
    assert.equal(response.status, 400, name)
  }
})

test('a well-formed name for a format the store cannot hold is refused', async () => {
  // Passes the whitelist and is still not something an `<img>` should be handed.
  // A 404 rather than a 400: the name is well-formed, there is simply no such
  // attachment - the store only ever mints one of four extensions.
  const response = await get(`${WEB_PATHS.attachments}${'a'.repeat(64)}.exe`, withSession())

  assert.equal(response.status, 404)
})

/** One socket, opened the way a browser opens it. */
function connect(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WEB_PATHS.socket}`, { headers })
    socket.on('open', () => resolve(socket))
    socket.on('error', reject)
  })
}

test('the socket refuses an upgrade with no session', async () => {
  await assert.rejects(connect({ origin: origin() }), /401/)
})

test('the socket refuses an upgrade from another origin', async () => {
  await assert.rejects(
    connect({ ...withSession(), origin: 'http://evil.example' }),
    /403/
  )
})

test('the socket requires an Origin, unlike a navigation', async () => {
  // A handshake is never a top-level navigation, so a browser always sends one
  // and anything that does not is not a browser.
  await assert.rejects(connect(withSession()), /403/)
})

test('a request over the socket is answered by the real dispatcher', async () => {
  const socket = await connect({ ...withSession(), origin: origin() })

  const answer = await new Promise<{ id: number; result?: unknown; error?: unknown }>(
    (resolve, reject) => {
      socket.on('message', (data: Buffer) =>
        resolve(JSON.parse(String(data)) as { id: number; result?: unknown; error?: unknown })
      )
      socket.on('error', reject)
      socket.send(JSON.stringify({ id: 1, method: 'repositories.list' }))
    }
  )

  socket.close()

  assert.equal(answer.id, 1)
  assert.equal(answer.error, undefined)
  // A database created moments ago by this test, migrated on first use.
  assert.deepEqual(answer.result, [])
})

test('a frame that is not a request is refused under an id it can be read with', async () => {
  const socket = await connect({ ...withSession(), origin: origin() })

  const answer = await new Promise<{ id: number; error?: { code: string } }>((resolve, reject) => {
    socket.on('message', (data: Buffer) =>
      resolve(JSON.parse(String(data)) as { id: number; error?: { code: string } })
    )
    socket.on('error', reject)
    socket.send('{"this":"is not a request"}')
  })

  socket.close()

  assert.equal(answer.id, 0)
  assert.equal(answer.error?.code, 'INVALID_INPUT')
})
