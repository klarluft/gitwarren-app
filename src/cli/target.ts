/**
 * The URL `gitwarren open` hands to a browser.
 *
 * Apart from the command for the reason `web/loopback-fragment.ts` is apart
 * from `bootstrap.ts`: this is the whole of the thinking and none of the
 * side effects, so it can be tested as a node program rather than by opening
 * windows on somebody's desktop.
 *
 * Three things have to agree in one string, and each comes from somewhere else:
 *
 *  - **the mount**, which depends on *who* is serving. An app serves the web
 *    view under `/app/`, because `/` is the "Open in GitWarren" page M2 is
 *    verified on; a `gitwarren serve --listen` has no such page to protect and
 *    serves it at `/`. `shared/web.ts` states this, and the runtime file says
 *    which of the two is up.
 *  - **the token**, from `core/web/token.ts` by way of the file the serving
 *    process published. This is exactly the "carried by `gitwarren open`" in
 *    M3's loopback-security bullet: the user never copies it.
 *  - **the fragment**, when a link was named. A fragment never reaches the
 *    server, so this part of the URL is addressed to the page.
 *
 * ## Nothing the caller typed is pasted through
 *
 * A link is parsed to a `Route` and the fragment written back out from that,
 * which is the rule M3.1 arrived at the hard way after a doubled `#` quietly
 * sent every agent link to the repository list. It also means `gitwarren open`
 * cannot be talked into putting an arbitrary string into a URL it then asks the
 * operating system to open, which is a nicer property than it sounds for a
 * command an agent may well be the one running.
 */
import {
  DEEP_LINK_SCHEME,
  LOOPBACK_HOST_PREFIX,
  loopbackFragmentFor,
  parseDeepLink
} from '../shared/deep-link.js'
import { LINK_SERVER_HOST, LINK_SERVER_PORT } from '../shared/link-port.js'
import { TOKEN_PARAM, WEB_APP_MOUNT } from '../shared/web.js'
import type { RuntimeOwner } from '../core/daemon-runtime.js'

const PREFIX = `${DEEP_LINK_SCHEME}://`

/**
 * The deep link a caller's argument means, or null when it is not one.
 *
 * Two spellings are accepted because both are things GitWarren itself hands
 * out. `gitwarren://<id>/review/4/files` is what an agent gets from the MCP
 * server; `http://127.0.0.1:41427/#h=<id>/review/4/files` is the `guiUrl` next
 * to it, and a user pasting one back is pasting whichever their terminal made
 * clickable. They are the same string with the scheme moved, which is the point
 * of the `h=` grammar - see `shared/deep-link.ts`.
 */
function asDeepLink(link: string): string | null {
  if (link.slice(0, PREFIX.length).toLowerCase() === PREFIX) return link

  const hash = link.indexOf('#')
  if (hash === -1) return null
  const fragment = link.slice(hash + 1)
  if (!fragment.startsWith(LOOPBACK_HOST_PREFIX)) return null
  return PREFIX + fragment.slice(LOOPBACK_HOST_PREFIX.length)
}

/**
 * The `#…` for a link, `''` for no link, or null when the argument is not a
 * GitWarren link at all.
 *
 * The empty string and null are deliberately different answers. No fragment
 * means the repository list, which is what `gitwarren open` with no argument
 * should do; an unrecognised argument is a mistake worth reporting, because
 * quietly opening the home screen is how a user spends five minutes wondering
 * why their link does not work.
 *
 * A link that parses to something other than a review - `gitwarren://<id>/` on
 * its own, which is a truncated link's landing place - also gets no fragment.
 * That is the same screen it asked for.
 */
export function fragmentFor(link: string | undefined): string | null {
  if (link === undefined || link.trim() === '') return ''

  const deepLink = asDeepLink(link.trim())
  if (deepLink === null) return null

  const route = parseDeepLink(deepLink)
  if (route === null) return null
  if (route.name !== 'review' || route.host === undefined) return ''

  const { host, ...local } = route
  return `#${loopbackFragmentFor(host, local)}`
}

/**
 * Where the browser should go.
 *
 * The mount always ends in `/` before the query. `/app?token=…` would be a
 * redirect at best and a 404 at worst, and the relative asset paths in the
 * built `index.html` resolve against the directory either way - so the
 * trailing slash is not cosmetic.
 */
export function webUrlFor(owner: RuntimeOwner, token: string, link?: string): string | null {
  const fragment = fragmentFor(link)
  if (fragment === null) return null

  const mount = owner === 'gui' ? `${WEB_APP_MOUNT}/` : '/'
  return (
    `http://${LINK_SERVER_HOST}:${LINK_SERVER_PORT}${mount}` +
    `?${TOKEN_PARAM}=${encodeURIComponent(token)}${fragment}`
  )
}
