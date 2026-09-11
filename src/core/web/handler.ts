/**
 * The web view: the renderer, served on loopback, over the same dispatcher the
 * window uses.
 *
 * This is a handler rather than a server, and that is the whole design. There
 * are two processes that may hold the loopback port - the Electron app, which
 * has been serving the "Open in GitWarren" page there since M2, and a
 * `gitwarren serve` for someone who will not install an Electron app - and they
 * must serve the *same* web build from the *same* port with the *same* gate.
 * One handler, mounted by each of them, is how that stays true. `mount` is the
 * only thing they disagree about:
 *
 *  - The app mounts at `/app/`, because `/` is the link page and that page is
 *    verified behaviour a review link depends on.
 *  - The daemon mounts at `/`, because there is no link page worth serving when
 *    there is no protocol handler to hand a link to - and a `guiUrl` opening
 *    the review directly, with no "Open in GitWarren" hop, is the thing M3 is
 *    for.
 *
 * The mount always ends in `/`. Asset URLs in the build are relative, so the
 * document's own path is what they resolve against, and a path without the
 * trailing slash would resolve them one level too high. Routes are in the hash,
 * so the path is *always* exactly the mount however deep the user has navigated
 * - which is what makes relative assets safe here and would not be true of a
 * history-API router.
 *
 * ## The gate, in the order a request meets it
 *
 * 1. `Host` must be the loopback authority, and `Origin` - when there is one -
 *    must be ours. See `origin.ts`; neither check is about tokens.
 * 2. `?token=…` on any path under the mount is exchanged for a session cookie
 *    and redirected away, so the secret does not stay in the address bar, in
 *    the history, or in a `Referer`.
 * 3. Without a valid cookie, every path answers the same short page saying how
 *    to get in. Not a 404: pretending the app is not there would be a lie the
 *    user cannot act on, and the port is not a secret anyway - the token is.
 *
 * Almost everything behind the gate is a read: the web build, `app-info`, and
 * since M3.2 the attachment bytes an `<img>` in a comment body needs. Writes to
 * review data happen over the socket and nowhere else, which is what kept this
 * file answering `GET` and `HEAD` and refusing every other method outright
 * through M5.
 *
 * M6 adds exactly one exception and it is worth naming here rather than leaving
 * to be discovered: `WEB_PATHS.notify` takes a `POST` from the *agent's*
 * process, saying that it changed something so the window does not wait fifteen
 * seconds to find out. It carries no data, names one event from a closed set,
 * and requires the token in a header on top of the host and origin checks - a
 * page cannot set one without a preflight this server never answers. The whole
 * argument, including why it is not a channel of its own, is in `notify.ts`.
 *
 * The socket is upgraded only after the same three, with `Origin` required
 * rather than optional, because a WebSocket handshake is never a navigation.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { serveWebSocket } from '../rpc/websocket.js'
import { serveAttachment } from './attachments.js'
import { serveNotify } from './notify.js'
import { isAllowedHost, isAllowedOrigin, loopbackAuthority } from './origin.js'
import { LINK_SERVER_PORT } from '../../shared/link-port.js'
import { serveStatic } from './static.js'
import { isWebToken } from './token.js'
import { ATTACHMENT_HOST_PARAM } from '../../shared/attachments.js'
import {
  SESSION_COOKIE,
  TOKEN_HEADER,
  TOKEN_PARAM,
  WEB_PATHS,
  WEB_PREFIX
} from '../../shared/web.js'
import type { AppInfo } from '../../shared/api.js'

export interface WebHandlerOptions {
  /** Always ends in `/`. `/` for the daemon, `/app/` for the Electron app. */
  mount: string
  /** The directory holding the web build - `out/web`. */
  staticRoot: string
  /** This launch's token. See `token.ts`. */
  token: string
  /** Facts about this install, for the browser shell. Read per request. */
  appInfo: () => AppInfo | Promise<AppInfo>
  /**
   * The port this handler is actually reachable on. Defaults to the fixed link
   * port, which is the only one either shell serves it on.
   *
   * It exists because the `Host` and `Origin` checks are assertions about the
   * authority *this* server was reached at, and a handler that hard-coded the
   * number could not be exercised anywhere but on that one port - which on a
   * developer's machine is usually held by their own running GitWarren.
   */
  port?: number
}

export interface WebHandler {
  /** True when the request was answered here; false leaves it to the caller. */
  request(request: IncomingMessage, response: ServerResponse): boolean
  /** True when the upgrade was taken; false leaves it to the caller. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): void
}

const NO_STORE = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
} as const

/**
 * Cookies, parsed only far enough to find one name.
 *
 * Deliberately not a general cookie parser: a browser sends what it sends, and
 * the only question here is whether a value under our name is the token.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return undefined
}

/**
 * One request header as a string.
 *
 * Node lowercases header names and folds a repeated one into an array. An array
 * here means a caller sent the token twice, which is not something the MCP
 * process does and not something worth guessing about - so it is refused by
 * coming back undefined rather than by picking one.
 */
function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The page shown to a request that has no session.
 *
 * Inert: no script, no form, no image, and a policy that permits none of the
 * three. It tells the user how to get a URL that works and says nothing about
 * the token itself - a page served to whoever asked is not the place to put a
 * secret, which is the entire point of the page.
 */
const UNAUTHORIZED_PAGE =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex"><title>GitWarren</title>' +
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;' +
  'font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
  'background:#fbfbfd;color:#1e2230}@media(prefers-color-scheme:dark){body{background:#14161d;' +
  'color:#eef0f6}}main{max-width:30rem;text-align:center}code{font-family:ui-monospace,' +
  'SFMono-Regular,Menlo,Consolas,monospace}</style></head><body><main>' +
  '<h1>This GitWarren needs its token</h1>' +
  '<p>Open the URL printed by <code>gitwarren serve</code>, or run ' +
  '<code>gitwarren open</code> on this machine.</p>' +
  '<p>The token is minted fresh each time GitWarren starts, so a link from an ' +
  'earlier run will not work.</p></main></body></html>\n'

const UNAUTHORIZED_HEADERS = {
  ...NO_STORE,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; " +
    "frame-ancestors 'none'; base-uri 'none'"
} as const

export function createWebHandler({
  mount,
  staticRoot,
  token,
  appInfo,
  port = LINK_SERVER_PORT
}: WebHandlerOptions): WebHandler {
  if (!mount.endsWith('/')) throw new Error(`A web mount must end in "/", got ${mount}`)

  // `noServer`: the HTTP server is not ours to own - the app's link server and
  // the daemon each have one already, and both need the upgrade to pass through
  // the same gate as a request before `ws` ever sees it.
  const sockets = new WebSocketServer({ noServer: true })

  /** Whether a pathname belongs to this handler at all. */
  const mine = (pathname: string): boolean =>
    pathname.startsWith(WEB_PREFIX) ||
    pathname === mount.slice(0, -1) ||
    pathname.startsWith(mount) ||
    // `/` under a `/` mount is `mount` itself, already covered; this is the
    // app's own mount typed without its slash, which is redirected below.
    (mount === '/' && pathname === '')

  const authorised = (request: IncomingMessage): boolean =>
    isWebToken(token, readCookie(request.headers.cookie, SESSION_COOKIE))

  return {
    request(request, response) {
      const url = new URL(request.url ?? '/', `http://${loopbackAuthority(port)}`)
      const pathname = decodeURIComponent(url.pathname)
      if (!mine(pathname)) return false

      if (!isAllowedHost(request.headers.host, port)) {
        response.writeHead(403, NO_STORE).end()
        return true
      }

      // Reads may arrive as a navigation, which carries no Origin. Anything
      // else is a page acting on its own behalf and must name itself.
      const isRead = request.method === 'GET' || request.method === 'HEAD'
      if (!isAllowedOrigin(request.headers.origin, { required: !isRead, port })) {
        response.writeHead(403, NO_STORE).end()
        return true
      }

      // The one write, and the only reason this file is no longer `GET` and
      // `HEAD` and nothing else. See `notify.ts` for what it is for and the
      // three independent reasons a web page cannot reach it. The token comes
      // in a header rather than the cookie, because the caller is a local Node
      // process and has no cookie jar - and a custom header is a lock of its
      // own against a page, which cannot set one without a preflight this
      // server never answers.
      if (pathname === WEB_PATHS.notify) {
        if (request.method !== 'POST') {
          response.writeHead(405, { ...NO_STORE, Allow: 'POST' }).end()
          return true
        }
        if (!isWebToken(token, readHeader(request, TOKEN_HEADER))) {
          response.writeHead(401, NO_STORE).end()
          return true
        }
        void serveNotify(request, response, NO_STORE)
        return true
      }

      if (!isRead) {
        response.writeHead(405, { ...NO_STORE, Allow: 'GET, HEAD' }).end()
        return true
      }

      // The token, exchanged for a cookie and taken straight back out of the
      // URL. `SameSite=Strict` is what makes a cross-site page unable to use
      // the session even when it can guess the port; `HttpOnly` keeps the value
      // out of reach of anything that manages to run script on the page.
      const presented = url.searchParams.get(TOKEN_PARAM)
      if (presented !== null) {
        if (!isWebToken(token, presented)) {
          response.writeHead(403, UNAUTHORIZED_HEADERS).end(UNAUTHORIZED_PAGE)
          return true
        }

        url.searchParams.delete(TOKEN_PARAM)
        // The fragment never reached this process - browsers do not send it -
        // and it survives a 302 on its own, which is what lets a link with a
        // route in it keep that route across the exchange.
        response
          .writeHead(302, {
            ...NO_STORE,
            'Set-Cookie':
              `${SESSION_COOKIE}=${encodeURIComponent(presented)}; Path=/; HttpOnly; ` +
              `SameSite=Strict`,
            Location: `${url.pathname}${url.search}`
          })
          .end()
        return true
      }

      if (!authorised(request)) {
        response.writeHead(401, UNAUTHORIZED_HEADERS).end(UNAUTHORIZED_PAGE)
        return true
      }

      if (pathname === WEB_PATHS.appInfo) {
        void Promise.resolve(appInfo())
          .then((info) => {
            response
              .writeHead(200, { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8' })
              .end(request.method === 'HEAD' ? undefined : JSON.stringify(info))
          })
          .catch((error: unknown) => {
            console.error('[web] could not describe this install', error)
            response.writeHead(500, NO_STORE).end()
          })
        return true
      }

      // Images in comment bodies. Behind the same cookie as everything else -
      // an attachment is review content, and a port that handed screenshots out
      // to whoever asked would be a hole the token exists to close.
      //
      // The host comes off the query rather than the path, so the pathname is
      // still `<sha>.<ext>` and the whitelist is still the whole of what
      // reaches a filesystem. See `ATTACHMENT_HOST_PARAM`.
      const attachmentHost = url.searchParams.get(ATTACHMENT_HOST_PARAM) ?? undefined
      if (serveAttachment(pathname, request.method ?? 'GET', response, attachmentHost).served) {
        return true
      }

      // The socket path only exists as an upgrade. A plain GET to it is a
      // mistake worth naming rather than a 404 among many.
      if (pathname === WEB_PATHS.socket) {
        response.writeHead(426, { ...NO_STORE, Upgrade: 'websocket' }).end()
        return true
      }

      if (pathname.startsWith(WEB_PREFIX)) {
        response.writeHead(404, NO_STORE).end()
        return true
      }

      // `/app` without its slash. Relative asset URLs in the document would
      // resolve against `/` from there, so the redirect is not cosmetic.
      if (pathname === mount.slice(0, -1)) {
        response.writeHead(302, { ...NO_STORE, Location: `${mount}${url.search}` }).end()
        return true
      }

      const within = pathname.slice(mount.length - 1) || '/'
      const { served } = serveStatic(staticRoot, within, request.method ?? 'GET', response)
      if (!served) response.writeHead(404, NO_STORE).end()
      return true
    },

    upgrade(request, socket, head) {
      const url = new URL(request.url ?? '/', `http://${loopbackAuthority(port)}`)
      if (decodeURIComponent(url.pathname) !== WEB_PATHS.socket) return false

      // A refusal here is a socket write, not a response object: the connection
      // has already left HTTP behind. Every one of them ends the connection
      // rather than leaving a half-upgraded socket around.
      const refuse = (status: string): true => {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return true
      }

      if (!isAllowedHost(request.headers.host, port)) return refuse('403 Forbidden')
      // Required, unlike on a read: an upgrade is never a top-level navigation,
      // so a browser always sends it and a missing one is not a browser.
      if (!isAllowedOrigin(request.headers.origin, { required: true, port }))
        return refuse('403 Forbidden')
      if (!authorised(request)) return refuse('401 Unauthorized')

      sockets.handleUpgrade(request, socket, head, (websocket) => {
        serveWebSocket(websocket)
      })
      return true
    },

    close() {
      sockets.close()
    }
  }
}
