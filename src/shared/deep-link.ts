/**
 * `gitwarren://review/...` - the URL that activates the app on a review.
 *
 * ## Why the link is a chain rather than one hop
 *
 * An agent working over MCP hands the user an `http://127.0.0.1:<port>/...`
 * URL, because that is what a terminal turns into something clickable; almost
 * no terminal linkifies a custom scheme. That address is served by the GUI's
 * own loopback server, which returns a page with a button pointing here.
 *
 * The button matters. The window has to be raised by an activation the OS
 * considers user-initiated, and only the foreground process - the browser the
 * user just clicked in - can confer that. An Electron app woken by a background
 * HTTP request has no foreground rights on Windows, so `win.focus()` there
 * flashes the taskbar and nothing more (electron#2867); Mutter demotes
 * self-requested activation in much the same way. A protocol launch inherits
 * the right on all three platforms, so the click has to reach the OS.
 *
 * ## Why the parsing lives here
 *
 * This URL is reachable by anyone who can get a string in front of the user -
 * an agent writing a comment body included - so it is hostile input by default.
 * It is parsed to a `Route` from a fixed vocabulary and never forwarded as a
 * string, exactly as `main/attachment-protocol.ts` whitelists an attachment
 * name rather than filtering it. Anything unrecognised degrades to the home
 * screen; nothing here can express a location the app does not already have.
 *
 * The grammar deliberately *is* the hash grammar, one host down: everything
 * after `gitwarren://review/` is what would follow `#/reviews/`. One notation,
 * one parser, no second dialect to keep in step.
 *
 * Since M2 the authority may instead be an instance id -
 * `gitwarren://<id>/review/4/files/...` - naming the install the review lives
 * on. That is what makes rule 4 work: the link is opened by whichever GitWarren
 * the user clicked from, and it has to be able to tell "this is my review" from
 * "this is the PC's". The bare `review` authority still parses and still means
 * the local install, so links minted before M2 are unaffected.
 *
 * Note that `gitwarren:` is also registered as a privileged scheme for
 * attachment images. The two are unrelated mechanisms - an OS protocol handler
 * and Chromium's `protocol.handle` - and they coexist because they answer to
 * different hosts: `attachmentResponse` 404s anything that is not `attachment`,
 * and this parser ignores anything that is not `review`.
 */
import { isInstanceId } from './instance-id.js'
import { parseRoute, type ReviewRoute, type Route } from './routes.js'

export const DEEP_LINK_SCHEME = 'gitwarren'
const PREFIX = `${DEEP_LINK_SCHEME}://`

/** The host that carries a review location. Anything else is not for us. */
const REVIEW_HOST = 'review'

/**
 * What introduces the instance id in a loopback link's fragment: `#h=<id>/...`.
 *
 * `h=` rather than the `h/` the hash router uses, because the two grammars
 * answer different questions and running them together would be a trap. The
 * fragment of a loopback URL is not a route into the app serving it - it is a
 * *deep link waiting to be assembled*, and the id in it names the install the
 * review is on rather than the install the page was loaded from. Those are the
 * same machine today and are exactly what stops being the same machine in M4,
 * so they get different notation now, while it costs nothing.
 */
export const LOOPBACK_HOST_PREFIX = 'h='

/**
 * The part of a deep link after `gitwarren://`.
 *
 * Also, unchanged, the fragment of the loopback URL: the page rebuilds the deep
 * link by pasting the scheme back on, which is how the route reaches the app
 * without the HTTP server ever being told what it is.
 */
export function deepLinkPathFor(route: ReviewRoute): string {
  const base = `${REVIEW_HOST}/${route.reviewId}/${route.tab}`
  if (!route.focus) return base

  const { filePath, side, line } = route.focus
  const at = side === undefined || line === undefined ? '' : `/${side}/${line}`
  return `${base}/${encodeURIComponent(filePath)}${at}`
}

/**
 * The whole URL, naming the install the review is on.
 *
 * The instance id goes in the authority - `gitwarren://<id>/review/4/files/...`
 * - which is the position a URL reserves for "whose". That is M2's change to
 * this grammar, and it is what lets rule 4 work: a link resolves on whichever
 * GitWarren the user clicked from, and that GitWarren can only know whether the
 * review is its own by being told which install minted the link.
 *
 * Omitting the id gives `gitwarren://review/...`, the link this app emitted
 * before M2, still meaning "on whatever install opens this". Every such link
 * already sitting in a terminal scrollback or a comment body keeps working, and
 * keeps meaning the same thing.
 */
export function deepLinkFor(route: ReviewRoute, instanceId?: string): string {
  const path = deepLinkPathFor(route)
  return instanceId === undefined ? PREFIX + path : `${PREFIX}${instanceId}/${path}`
}

/**
 * The fragment of the loopback URL an agent hands out.
 *
 * The page at the other end pastes `gitwarren://` onto what it finds here,
 * which is why this is the deep link's path with the instance in front rather
 * than anything of its own. The server is never told any of it: a fragment does
 * not leave the browser.
 */
export function loopbackFragmentFor(instanceId: string, route: ReviewRoute): string {
  return `${LOOPBACK_HOST_PREFIX}${instanceId}/${deepLinkPathFor(route)}`
}

/**
 * A `Route` for a deep link, or null when the URL is not one of ours.
 *
 * Null means "ignore this entirely" - a URL for the attachment host, or a
 * different scheme altogether. A URL that *is* addressed to us but is malformed
 * inside resolves to the home screen instead, so a mangled link opens the app
 * on something harmless rather than being silently swallowed.
 *
 * Two authorities are accepted and they mean different things. `review` is the
 * pre-M2 form and carries no opinion about which install the review is on, so
 * it resolves locally. An instance id says which install minted the link, and
 * the route comes back host-scoped whether or not that id is this machine's -
 * this module has no way to know, since it is compiled for the renderer too and
 * may not read a file. Deciding "that is me" is the caller's job, and
 * `main/deep-link.ts` is where it happens.
 */
export function parseDeepLink(url: string): Route | null {
  // Schemes are case-insensitive; `GitWarren://` is the same URL.
  if (!url || url.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null

  // Neither a query nor a fragment is part of the grammar, and the OS is free
  // to hand us a URL carrying either.
  const body = url.slice(PREFIX.length).split(/[?#]/)[0] ?? ''
  const segments = body.split('/').filter(Boolean)

  // Hosts are case-insensitive, and macOS is known to normalise them. An
  // instance id is lowercase hex by construction, so the same fold serves both.
  const authority = segments[0]?.toLowerCase()

  // Handing the rest to the hash parser is what keeps the two grammars from
  // drifting. It is total - garbage lands on the home screen - which is the
  // failure mode this wants.
  if (authority === REVIEW_HOST) return parseRoute(`#/reviews/${segments.slice(1).join('/')}`)

  if (authority !== undefined && isInstanceId(authority)) {
    const rest = segments.slice(1)
    // `gitwarren://<id>/` on its own is that install's repository list, which is
    // a real location and the right landing place for a truncated link.
    if (rest.length === 0) return { name: 'repositories', host: authority }
    // Anything but `review` under an instance is as unrecognised as it was
    // before the id existed. Same answer: not for us.
    if (rest[0]?.toLowerCase() !== REVIEW_HOST) return null
    return parseRoute(`#/h/${authority}/reviews/${rest.slice(1).join('/')}`)
  }

  return null
}
