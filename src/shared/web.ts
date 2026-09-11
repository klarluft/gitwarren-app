/**
 * The names the browser shell and the server both have to know.
 *
 * The web build is served by the same process that answers it, so every string
 * in here is agreed on by exactly two files that could otherwise drift: a path
 * the server routes on, and the same path typed again in the bootstrap. They
 * are collected here for the same reason `shared/routes.ts` exists - one
 * grammar, spoken by a Node process and by a browser, neither importing the
 * other's world.
 *
 * Plain JS only. No Node, no Electron: this is compiled into a browser bundle.
 *
 * ## Why everything the shell needs lives under one prefix
 *
 * `/gitwarren/…` is reserved for the shell; everything else under the mount is
 * a file from the web build. A single prefix is what lets the static server say
 * "not mine" in one comparison, and it means a renderer asset can never shadow
 * the socket by being named `socket`. It is deliberately not `/api`: nothing
 * here is an API in the sense the dispatcher is - see the note on
 * `WEB_PATHS.appInfo` below.
 */

import { ATTACHMENT_FILE_NAME, ATTACHMENT_HOST_PARAM, attachmentName } from './attachments.js'

/** Everything the browser shell talks to, under one reserved prefix. */
export const WEB_PREFIX = '/gitwarren'

export const WEB_PATHS = {
  /**
   * The WebSocket carrier. One socket per tab, every method over it.
   *
   * A path rather than a subprotocol so that an upgrade to anything else on
   * this server is a refusal rather than a negotiation.
   */
  socket: `${WEB_PREFIX}/socket`,
  /**
   * Facts about the install serving this page: version, instance id, where its
   * database is, how an agent starts its MCP server.
   *
   * Not on the dispatcher, and not an action. The dispatcher may not have
   * capabilities (see `core/rpc/dispatcher.ts`), and this is not one: it reads
   * nothing but what the process already knows about itself. The line that
   * matters, and the one to hold when the phone arrives in M6, is that a *fact
   * about the host* may travel and a *capability of the host* may not.
   * Revealing a folder or launching an editor stays with the machine the person
   * is sitting at, which in a browser tab means it is simply absent.
   */
  appInfo: `${WEB_PREFIX}/app-info`,
  /**
   * Attachment bytes, one file per name: `…/attachments/<sha>.<ext>`.
   *
   * A prefix rather than a path, and the one thing under here that is not a
   * single endpoint. It exists because `gitwarren://attachment/…` is a custom
   * scheme only the Electron main process can serve, and a tab needs the same
   * images. Serving them over HTTP rather than inlining them as `data:` URLs in
   * the comment body keeps the cache, the range requests and the memory
   * behaviour a browser already has for images, and keeps a body the same
   * string in both shells.
   *
   * A read, and only a read - the way *in* is `attachments.ingest` on the
   * dispatcher, which is where the size limit and the format sniff live. There
   * is no upload endpoint here and there should not be one.
   */
  attachments: `${WEB_PREFIX}/attachments/`,
  /**
   * The one thing under here that is written to rather than read: an agent's
   * process telling the owner of this data directory that it changed something.
   *
   * It is the M6 answer to "how does the MCP process poke the owner", and the
   * argument for it being *here* rather than a channel of its own is that the
   * channel already exists. `daemon-runtime.json` names the owning process and
   * its `linkPort`; that process is already serving this handler on it; and the
   * 0600 token beside the runtime file is readable by exactly the principal
   * that may poke - the user. The alternative the plan offered was a counter in
   * a file, which is a poll with extra steps: something would have to watch it,
   * and `fs.watch` is per platform, unreliable on network filesystems and a
   * timer underneath on several of them.
   *
   * `POST`, and it is the only non-idempotent request this server answers. What
   * it accepts is a *name* from a closed vocabulary and nothing else, so the
   * most a local process can do with it is make a window re-read something -
   * which it could already cause by writing to the database it can already
   * open. See `core/web/notify.ts`.
   */
  notify: `${WEB_PREFIX}/notify`
} as const

/**
 * How a non-browser presents the session token.
 *
 * The cookie exchange in `core/web/handler.ts` is built for a browser arriving
 * by navigation, and the MCP process is neither. A header is the natural
 * spelling for it - and it is a *stronger* lock rather than a convenience,
 * because a cross-origin page cannot set a custom header without a preflight
 * this server never answers. So the notify endpoint takes the token here and
 * nowhere else: not in the query, where it would end up in a log, and not in
 * the cookie, which only a browser has.
 */
export const TOKEN_HEADER = 'x-gitwarren-token'

/**
 * The same image, addressed the way a browser tab can fetch it.
 *
 * A comment body holds `gitwarren://attachment/<name>` whoever reads it - the
 * body is stored text and must not depend on which shell renders it. So the
 * rewrite happens at the `<img src>` and nowhere else: the Electron window
 * passes the token through to its custom scheme, and a tab turns it into a path
 * on this origin.
 *
 * Anything that is not one of our tokens comes back unchanged, so the caller's
 * own decision about what to do with a foreign URL - render it as a link, per
 * `components/markdown.tsx` - is still the caller's to make.
 *
 * Since M4.4 it also carries which machine's store to read from, because a tab
 * can be looking at a review on another computer. Absent means this one.
 */
export function webAttachmentSrc(url: string, host?: string): string {
  const name = attachmentName(url)
  if (name === null) return url
  const path = `${WEB_PATHS.attachments}${name}`
  // The host goes on as a query, exactly as it does on the custom scheme, so
  // that one rule in `shared/attachments.ts` describes both shells. See
  // `ATTACHMENT_HOST_PARAM` for why it is not in the token itself.
  return host === undefined ? path : `${path}?${ATTACHMENT_HOST_PARAM}=${encodeURIComponent(host)}`
}

/**
 * The store filename a request under the attachments prefix is asking for, or
 * null when the path is not one.
 *
 * The other half of `webAttachmentSrc`, and the reason both live here: this is
 * the pair of functions most able to drift apart, and one of them is compiled
 * into a browser bundle while the other runs in the server that answers it.
 *
 * `pathname` arrives decoded, so a name that decoded into a `/` fails the
 * pattern rather than becoming two segments.
 */
export function attachmentNameFromWebPath(pathname: string): string | null {
  if (!pathname.startsWith(WEB_PATHS.attachments)) return null
  const name = pathname.slice(WEB_PATHS.attachments.length)
  return ATTACHMENT_FILE_NAME.test(name) ? name : null
}

/**
 * The cookie the session lives in, once a token has been exchanged for it.
 *
 * `__Host-` is the prefix that would normally belong here, and it is left off
 * deliberately: browsers only honour it on secure origins, and loopback http is
 * not one. The properties the prefix would have guaranteed are set explicitly
 * instead - `Path=/`, no `Domain`, `SameSite=Strict` - and the Host check on
 * every request is what closes the gap the missing `Secure` leaves.
 */
export const SESSION_COOKIE = 'gitwarren_session'

/** How a token is handed over the first time: `?token=…` on any web path. */
export const TOKEN_PARAM = 'token'

/**
 * Where the Electron app mounts the web build.
 *
 * The app cannot serve it at `/`, because `/` on the loopback port is the
 * "Open in GitWarren" page an agent's link lands on, and that page is verified
 * behaviour since M2. A `gitwarren serve` with no app next to it has no such
 * page to protect and no protocol handler to hand a link to, so it serves the
 * web build at `/` instead and a link opens the review directly - which is the
 * hop M3 exists to remove. Same server, same files, two landings.
 */
export const WEB_APP_MOUNT = '/app'
