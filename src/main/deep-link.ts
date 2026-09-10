/**
 * Receiving `gitwarren://` URLs from the operating system.
 *
 * The same URL arrives by three different doors depending on the platform, and
 * all three end up in `receiveDeepLink`:
 *
 *  - macOS delivers it as `open-url`, which can fire *before* `whenReady` when
 *    the click is what started the app. The route is buffered in that case and
 *    picked up by the window as it is created.
 *  - Windows and Linux pass it in `process.argv` of a cold start.
 *  - Windows and Linux pass it in the argv of a *second* start, which the
 *    single-instance lock turns into `second-instance` on the running process.
 *
 * The URL never travels further than this module as a string. It is parsed to a
 * `Route` first (see `shared/deep-link.ts` for why that boundary is drawn hard)
 * and the renderer is handed a hash this process generated from that route, so
 * nothing an outside party wrote reaches `loadURL` or `location.hash` intact.
 *
 * This is also where a link stops being about "a review" and becomes about "a
 * review on a particular install". A link minted since M2 names the instance it
 * came from, and only a process that can read this data directory can say
 * whether that is us - which is why the shared parser hands back a host-scoped
 * route either way and `localise` below makes the call.
 */
import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { getInstanceId } from '../core/instance.js'
import { IPC_CHANNELS } from '../shared/api.js'
import { DEEP_LINK_SCHEME, parseDeepLink } from '../shared/deep-link.js'
import { HOME, hrefFor, type Route } from '../shared/routes.js'

/**
 * A route that arrived before there was a window to show it in.
 *
 * Held rather than dropped because on macOS the whole point of a cold start
 * from a link is that the app opens *on that review*, and the URL is delivered
 * before `whenReady` resolves.
 */
let pending: Route | null = null

/**
 * How to open a window when a link arrives and there is none.
 *
 * That happens on macOS, where closing the last window does not quit the app -
 * it sits in the dock, perfectly able to receive a URL and with nothing to show
 * it in. Without this the route would be buffered and nobody would ever come to
 * collect it.
 */
let openWindow: (() => void) | null = null

/**
 * Hand over the window factory. Call once, *after* the first window exists:
 * a URL buffered during startup should be picked up by that window rather than
 * open a second one alongside it.
 */
export function setWindowFactory(factory: () => void): void {
  openWindow = factory
}

/**
 * Tell the OS this app answers for `gitwarren:`.
 *
 * Packaging declares the same thing statically - `protocols:` in
 * electron-builder.yml, which becomes an Info.plist entry, a registry key or a
 * desktop-file MimeType. This call is what makes the link work in development
 * as well, and it is also how the association is repaired if something else
 * claimed the scheme.
 *
 * In development the running executable is Electron itself, so passing only
 * `process.execPath` would register "a bare Electron" as the handler and the
 * link would open an empty app. `process.defaultApp` is true in exactly that
 * situation, and the entry script has to be passed along explicitly.
 */
export function registerDeepLinkClient(): void {
  if (process.defaultApp) {
    const entry = process.argv[1]
    if (entry) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(entry)])
    return
  }

  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
}

/** The first argument that is a deep link, as a route. Null when there is none. */
function routeFromArgv(argv: readonly string[]): Route | null {
  for (const argument of argv) {
    const route = parseDeepLink(argument)
    if (route) return route
  }
  return null
}

/**
 * Show a route in the window, or remember it until there is one.
 *
 * The focus call here is not what raises the window - see `link-server.ts` for
 * why that has to come from the OS activation instead - but it is what restores
 * a minimised window and picks the right one on macOS, where the app may
 * already be frontmost with everything hidden.
 */
function show(route: Route): void {
  const [window] = BrowserWindow.getAllWindows()
  if (!window) {
    // Buffer first: the window this opens reads the route back out of here as
    // its starting location.
    pending = route
    openWindow?.()
    return
  }

  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()

  // A window that is still loading has no listener yet, and the renderer's own
  // first read of the hash would win anyway. Waiting for the load is the only
  // way the message is not simply dropped.
  const send = (): void => window.webContents.send(IPC_CHANNELS.navigationDeepLink, hrefFor(route))
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send)
  else send()
}

/**
 * Resolve a link's instance id against this install.
 *
 * Rule 4: a link resolves where it is clicked. The id in the URL says which
 * install the review is on, and the three answers are:
 *
 *  - no id at all - a link minted before M2, which meant "local" then and means
 *    "local" now;
 *  - our own id - the same thing, said explicitly; the segment is dropped so
 *    the renderer is handed the route it would have been handed anyway;
 *  - somebody else's id - a review on another machine. There is no way to reach
 *    another machine until M4, and the one thing that must not happen is
 *    opening *our* review 4 because the link said 4. The user lands on the home
 *    screen and the id is logged, which is the honest failure until there is a
 *    hosts table to look it up in.
 */
function localise(route: Route): Route {
  if (route.host === undefined) return route
  if (route.host === getInstanceId()) {
    // Rebuilt without the key rather than set to undefined: `hrefFor` and route
    // equality both read the presence of the property, not its value.
    const { host: _host, ...local } = route
    return local
  }

  console.log(
    `[deep-link] ignoring a link for instance ${route.host}, which is not this install. ` +
      `Reviews on other hosts arrive in M4.`
  )
  return HOME
}

/** Handle one URL from any of the three doors. Unrecognised URLs are ignored. */
export function receiveDeepLink(url: string): void {
  const route = parseDeepLink(url)
  if (!route) return
  show(localise(route))
}

/** Handle a whole argv, which is how Windows and Linux deliver a link. */
export function receiveDeepLinkFromArgv(argv: readonly string[]): void {
  const route = routeFromArgv(argv)
  if (route) show(localise(route))
}

/**
 * Whether a link is waiting, without taking it.
 *
 * Startup has to ask twice about the same route and for different reasons: once
 * to decide whether a launch that was asked to be hidden should show a window
 * after all, and once - inside `createWindow` - to turn it into that window's
 * first paint. Only the second consumes it.
 */
export function hasPendingRoute(): boolean {
  return pending !== null
}

/**
 * The buffered route, consumed.
 *
 * Read by `createWindow`, which turns it into the window's initial hash. That
 * is better than navigating after load: the app paints the review once instead
 * of painting the repository list and then jumping.
 */
export function takePendingRoute(): Route | null {
  const route = pending
  pending = null
  return route
}
