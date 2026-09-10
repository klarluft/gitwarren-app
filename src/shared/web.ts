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
  appInfo: `${WEB_PREFIX}/app-info`
} as const

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
