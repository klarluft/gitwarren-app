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
 * Note that `gitwarren:` is also registered as a privileged scheme for
 * attachment images. The two are unrelated mechanisms - an OS protocol handler
 * and Chromium's `protocol.handle` - and they coexist because they answer to
 * different hosts: `attachmentResponse` 404s anything that is not `attachment`,
 * and this parser ignores anything that is not `review`.
 */
import { parseRoute, type ReviewRoute, type Route } from './routes.js'

export const DEEP_LINK_SCHEME = 'gitwarren'
const PREFIX = `${DEEP_LINK_SCHEME}://`

/** The host that carries a review location. Anything else is not for us. */
const REVIEW_HOST = 'review'

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
  return `${base}/${encodeURIComponent(filePath)}/${side}/${line}`
}

export function deepLinkFor(route: ReviewRoute): string {
  return PREFIX + deepLinkPathFor(route)
}

/**
 * A `Route` for a deep link, or null when the URL is not one of ours.
 *
 * Null means "ignore this entirely" - a URL for the attachment host, or a
 * different scheme altogether. A URL that *is* addressed to us but is malformed
 * inside resolves to the home screen instead, so a mangled link opens the app
 * on something harmless rather than being silently swallowed.
 */
export function parseDeepLink(url: string): Route | null {
  // Schemes are case-insensitive; `GitWarren://` is the same URL.
  if (!url || url.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return null

  // Neither a query nor a fragment is part of the grammar, and the OS is free
  // to hand us a URL carrying either.
  const body = url.slice(PREFIX.length).split(/[?#]/)[0] ?? ''
  const segments = body.split('/').filter(Boolean)

  // Hosts are case-insensitive, and macOS is known to normalise them.
  if (segments[0]?.toLowerCase() !== REVIEW_HOST) return null

  // Handing the rest to the hash parser is what keeps the two grammars from
  // drifting. It is total - garbage lands on the home screen - which is the
  // failure mode this wants.
  return parseRoute(`#/reviews/${segments.slice(1).join('/')}`)
}
