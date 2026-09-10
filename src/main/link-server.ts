/**
 * A one-page HTTP server on loopback, whose only job is to hold a button.
 *
 * An agent working over MCP wants to hand the user a clickable pointer at the
 * review it just wrote. `gitwarren://review/3` would do it, except that almost
 * no terminal linkifies a custom scheme - and an `http://127.0.0.1:<port>/`
 * URL is linkified by all of them. So the agent gives out an http URL, this
 * serves a page at it, and the page carries the `gitwarren://` link.
 *
 * The button is not a workaround for a redirect that would be nicer. Browsers
 * refuse scripted navigation to a custom scheme, and more importantly the click
 * is what makes the window actually come forward: Windows grants foreground
 * rights only to the process that *is* foreground or that started the one
 * asking, so an Electron app woken by a background HTTP request cannot raise
 * itself - `win.focus()` flashes the taskbar and stops there (electron#2867).
 * GNOME's Mutter demotes self-requested activation similarly. A protocol launch
 * from the browser the user just clicked in inherits the right on all three
 * platforms. The click has to reach the OS, so it is a link, not a redirect.
 *
 * ## This server never does anything
 *
 * It answers every request with the same static page and has no other endpoint.
 * That is a property worth defending rather than an accident of it being small:
 * anything on loopback is reachable by every process on the machine and by any
 * web page the user happens to have open, so an endpoint here that mutated
 * state, read a repository or drove IPC would be a capability handed to
 * whatever the user visits next. Keep it an inert file server. The route it is
 * linking to never even reaches it - that rides in the URL fragment, which
 * browsers do not send.
 */
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { LINK_SERVER_HOST, LINK_SERVER_PORT } from '../shared/link-port.js'
import { DEEP_LINK_SCHEME, LOOPBACK_HOST_PREFIX } from '../shared/deep-link.js'
import { INSTANCE_ID_PATTERN } from '../shared/instance-id.js'
// `?asset` copies the file next to the bundle so it also exists at runtime -
// the same mechanism the window icon uses. It is inlined into the page as a
// data: URI because the page has to be self-contained: serving it as a second
// resource would mean a second endpoint, which is exactly what this file is
// trying not to have.
import logoPath from '../renderer/src/assets/logo.png?asset'

let server: Server | null = null

/**
 * The port actually being served, or null when the bind failed.
 *
 * Not the same question as "what port do links use". Links use
 * `LINK_SERVER_PORT` and nothing else, because they are minted for other
 * machines and other days; this says whether *this* machine is currently
 * answering on it, which is what the runtime file publishes and what the Agent
 * Access panel needs in order to warn.
 */
let servedPort: number | null = null

export function getLinkServerPort(): number | null {
  return servedPort
}

/**
 * Theme tokens copied from `renderer/src/index.css`, so the page reads as part
 * of the app rather than as a stray browser tab.
 *
 * Copied rather than imported: this string is built in the main process, which
 * has no Tailwind and no stylesheet pipeline. The renderer switches schemes
 * with a `.dark` class it sets from the OS setting; here there is no script
 * worth spending on it, so `prefers-color-scheme` does the same job directly.
 */
const STYLES = `
:root {
  --background: oklch(0.99 0.002 265);
  --foreground: oklch(0.21 0.01 265);
  --muted-foreground: oklch(0.53 0.014 265);
  --card: oklch(1 0 0);
  --border: oklch(0.92 0.005 265);
  --primary: oklch(0.53 0.19 264);
  --primary-foreground: oklch(0.99 0.002 265);
  --radius: 0.65rem;
  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.17 0.008 265);
    --foreground: oklch(0.95 0.004 265);
    --muted-foreground: oklch(0.68 0.012 265);
    --card: oklch(0.21 0.009 265);
    --border: oklch(0.29 0.011 265);
    --primary: oklch(0.68 0.16 264);
    --primary-foreground: oklch(0.17 0.008 265);
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

.card {
  width: 100%;
  max-width: 24rem;
  padding: 2rem 1.75rem;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius) + 0.25rem);
}

.logo { width: 56px; height: 56px; border-radius: var(--radius); }

h1 {
  margin: 1rem 0 0;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

p { margin: 0.4rem 0 0; font-size: 0.85rem; color: var(--muted-foreground); }

.target {
  margin-top: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}

a.button {
  display: inline-block;
  margin-top: 1.4rem;
  padding: 0.6rem 1.15rem;
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 0.9rem;
  font-weight: 600;
  text-decoration: none;
}

a.button:hover { filter: brightness(1.08); }
a.button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

[hidden] { display: none !important; }
`

/**
 * The page's only script.
 *
 * The route is in the fragment, which is why there is a script at all: the
 * server is never told which review this link is for, so the page has to read
 * it out of its own address and rebuild the `gitwarren://` URL client-side.
 *
 * Since M2 the fragment also carries the instance id of the install the review
 * is on - `#h=<id>/review/4/files/...` - and the id goes into the authority of
 * the deep link the button holds. That is what lets the app the user clicks
 * through to tell "this is my review" from "this is the other machine's". The
 * id is optional: a loopback link minted before M2 has a bare route in its
 * fragment and still builds the deep link it always built.
 *
 * The fragment is checked before it is used, but only as far as this page needs
 * to: enough to name the review in the line under the button, and no further.
 * The app is the allowlist - `shared/deep-link.ts` re-parses all of this and
 * drops whatever it does not recognise - so a stricter test here would only
 * manage to throw away a review id the app would have honoured. The scheme is a
 * fixed prefix and the id is matched against the instance pattern, so nothing
 * that arrives can become a `javascript:` href or smuggle a second authority.
 *
 * Written without template literals so it can sit inside one.
 */
const SCRIPT = `
var SHAPE = /^review\\/[0-9]{1,15}(?:\\/[a-z]{1,20}(?:\\/[^\\s]{1,4096})?)?$/;
var FOCUS = /^([^/]+)\\/(?:base|head)\\/([0-9]{1,15})$/;
var HOST = /${INSTANCE_ID_PATTERN.source}/;
// Left percent-encoded: a file path is one segment only because its slashes
// are escaped, and decoding the fragment whole would shatter it into several.
var fragment = location.hash.replace(/^#/, '');

// The id, split off the front if it is there at all. Anything that is not an
// instance id is not an instance id, and the whole fragment stays the route -
// which is exactly how a pre-M2 link keeps working.
var host = '';
var path = fragment;
if (path.slice(0, ${JSON.stringify(LOOPBACK_HOST_PREFIX)}.length) === ${JSON.stringify(LOOPBACK_HOST_PREFIX)}) {
  var rest = path.slice(${JSON.stringify(LOOPBACK_HOST_PREFIX)}.length);
  var cut = rest.indexOf('/');
  var candidate = cut === -1 ? rest : rest.slice(0, cut);
  if (HOST.test(candidate)) {
    host = candidate;
    path = cut === -1 ? '' : rest.slice(cut + 1);
  }
}

var known = SHAPE.test(path);

var open = document.getElementById('open');
open.href = ${JSON.stringify(DEEP_LINK_SCHEME + '://')} + (host ? host + '/' : '') + (known ? path : 'review/');

var target = document.getElementById('target');
if (known) {
  var parts = path.split('/');
  var text = 'Review #' + parts[1];
  if (parts[2]) text += ' \\u00b7 ' + parts[2];

  var focus = FOCUS.exec(parts.slice(3).join('/'));
  if (focus) {
    var file = focus[1];
    // A stray % makes this throw, and a name is not worth failing the page for.
    try { file = decodeURIComponent(file); } catch (error) {}
    text += ' \\u00b7 ' + file + ':' + focus[2];
  }

  target.textContent = text;
} else {
  document.getElementById('lead').textContent =
    'This link has lost its destination, so this opens GitWarren itself.';
  target.hidden = true;
}

// Left as it is afterwards on purpose. A tab the user did not open with
// window.open cannot close itself, so promising otherwise would just leave a
// dead page saying "closing"; saying "opening" and stopping is honest.
open.addEventListener('click', function () {
  document.getElementById('lead').textContent = 'Opening GitWarren\\u2026';
  target.hidden = true;
  open.hidden = true;
});
`

/**
 * Built once at startup rather than per request: it is the same bytes every
 * time, logo included, and reading a 31 KB file on each hit would be silly.
 */
function buildPage(): string {
  let logo = ''
  try {
    logo = `<img class="logo" src="data:image/png;base64,${readFileSync(logoPath).toString('base64')}" alt="">`
  } catch (error) {
    // A missing logo is a cosmetic failure; the button is the point.
    console.error('[links] could not inline the logo', error)
  }

  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex">\n' +
    '<title>Open in GitWarren</title>\n' +
    `<style>${STYLES}</style>\n` +
    '</head>\n' +
    '<body>\n' +
    '<main class="card">\n' +
    logo +
    '<h1>Open this in GitWarren</h1>\n' +
    '<p id="lead">GitWarren is running on this machine.</p>\n' +
    '<p class="target" id="target"></p>\n' +
    '<a class="button" id="open" href="gitwarren://review/">Open GitWarren</a>\n' +
    '</main>\n' +
    `<script>${SCRIPT}</script>\n` +
    '</body>\n' +
    '</html>\n'
  )
}

/**
 * `default-src 'none'` and then back only what the page uses. Overkill for a
 * static page with no network access, which is the point: if this ever grows a
 * second resource, the policy has to be widened deliberately.
 */
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
    "script-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
} as const

/**
 * Start listening on loopback, on the one port links are minted against.
 *
 * `127.0.0.1` explicitly and never `0.0.0.0`: the default would publish this on
 * every interface the machine has.
 *
 * The port is fixed - see `shared/link-port.ts` - and there is deliberately no
 * fallback to an OS-assigned one. A link now says 41427 whoever minted it and
 * whenever they minted it, so falling back would mean this app cheerfully
 * serving on a port nobody links to, while the links it hands out point at
 * whatever process actually holds 41427. Failing to listen is the honest
 * outcome, and it is reported: `EADDRINUSE` is named as such so the Agent
 * Access panel can say the port is taken rather than that links are broken.
 *
 * Failure is otherwise logged and swallowed. Deep links stop working; the app
 * is entirely usable, and refusing to start over it would be absurd.
 */
export function startLinkServer(onSettled?: (port: number | null) => void): void {
  if (server) return

  const page = buildPage()

  const listening = createServer((request, response) => {
    // The only Host that can legitimately reach this is the one we handed out.
    // Cheap, and it forecloses DNS rebinding - a name that resolves to 127.0.0.1
    // would otherwise let a web page talk to this from its own origin.
    if (request.headers.host !== `${LINK_SERVER_HOST}:${LINK_SERVER_PORT}`) {
      response.writeHead(403).end()
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }

    // Every path, deliberately: there is one page and no routing to get wrong.
    response.writeHead(200, HEADERS)
    response.end(request.method === 'HEAD' ? undefined : page)
  })

  server = listening

  listening.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[links] port ${LINK_SERVER_PORT} is already in use, so links into this app will not ` +
          `open until whatever holds it releases it. Links are still handed out: they name the ` +
          `same port on every machine, so an agent's link must not depend on this one's luck.`
      )
    } else {
      console.error('[links] loopback server failed', error)
    }

    // Only the first failure settles the caller; a later error on a server that
    // was up is a stop, not a start.
    const wasListening = servedPort !== null
    server = null
    servedPort = null
    if (!wasListening) onSettled?.(null)
  })

  listening.listen(LINK_SERVER_PORT, LINK_SERVER_HOST, () => {
    servedPort = LINK_SERVER_PORT
    console.log(`[links] serving deep links on http://${LINK_SERVER_HOST}:${LINK_SERVER_PORT}`)
    onSettled?.(LINK_SERVER_PORT)
  })
}

export function stopLinkServer(): void {
  server?.close()
  server = null
  servedPort = null
}
