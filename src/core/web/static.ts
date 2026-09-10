/**
 * Serving the web build off disk, with the two rules that matter for a file
 * server pointed at a directory inside an application bundle.
 *
 * **Nothing outside the root, ever.** The path comes from a URL, and a URL can
 * say `..`, can say it percent-encoded, and on Windows can say `..\`. The
 * defence is not to sanitise the request but to resolve it and then check where
 * it landed: `resolve()` collapses every traversal there is, and a result that
 * is not under the root is refused whatever it looks like. This is the same
 * shape as the worktree confinement M0 put on `core/git.ts`, and it is the only
 * one worth trusting - a blocklist of dangerous spellings is a list someone
 * will find a new entry for.
 *
 * **A single-page app needs an index fallback, and it must not become an open
 * redirect to `index.html` for everything.** A request for a path with no file
 * behind it is answered with the document, so a deep link into the app works on
 * a cold load; a request for a *missing asset* is answered with 404, because
 * handing back HTML with a `.js` content type is how a blank page with a
 * baffling console error happens. The difference is whether the path looks like
 * a file, which here means "the last segment has an extension".
 *
 * Read fresh on every request rather than cached in memory: the files are small
 * and the OS page cache is better at this than a Map, and it means a dev build
 * replaced on disk is served without restarting the process.
 */
import { createReadStream, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

/**
 * `nosniff` is the load-bearing one: it is what stops a browser deciding for
 * itself that something we labelled `text/plain` is really a script.
 *
 * There is no Content-Security-Policy here. The renderer is a React app with
 * inline styles from Tailwind and dynamic imports, and a policy that permitted
 * all of it would permit anything worth stopping. What contains this page is
 * the origin it is served from: nothing else may talk to it (see `origin.ts`)
 * and nothing may frame it.
 */
const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
} as const

/**
 * Hashed assets are immutable; the document never is.
 *
 * Vite puts a content hash in every filename under `assets/`, so those may be
 * cached forever - a new build is a new name. `index.html` names them, so it
 * must never be cached at all, or an updated app would keep loading the files
 * the stale document points at.
 */
function cacheControlFor(pathname: string): string {
  return pathname.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Whether a request is asking for a file rather than for a screen. */
function looksLikeAFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return last.includes('.')
}

/**
 * The file on disk a pathname refers to, or null when it escapes the root.
 *
 * The pathname arrives already decoded, and a decoded segment may contain a
 * `/` or a `\` that was encoded precisely so it would not be seen as a
 * separator - so the check is on the resolved result, after `join` has had its
 * way with it, and never on the input.
 */
function resolveWithin(root: string, pathname: string): string | null {
  const candidate = resolve(join(root, pathname))
  const rootWithSeparator = root.endsWith(sep) ? root : root + sep
  if (candidate !== root && !candidate.startsWith(rootWithSeparator)) return null
  return candidate
}

export interface StaticResult {
  /** False when nothing was sent, so the caller can answer 404 in its own voice. */
  served: boolean
}

/**
 * Answer a request from `root`.
 *
 * `pathname` is relative to the mount, decoded, and always starts with `/`.
 * Streaming rather than `readFileSync`: the diff bundle is not small and there
 * is no reason to hold a copy of it per request.
 */
export function serveStatic(
  root: string,
  pathname: string,
  method: string,
  response: ServerResponse
): StaticResult {
  const target = resolveWithin(root, pathname)
  if (target === null) {
    response.writeHead(403, COMMON_HEADERS).end()
    return { served: true }
  }

  const file = pickFile(target, pathname, root)
  if (file === null) return { served: false }

  response.writeHead(200, {
    ...COMMON_HEADERS,
    'Content-Type': contentTypeFor(file),
    'Content-Length': statSync(file).size,
    'Cache-Control': cacheControlFor(pathname)
  })

  if (method === 'HEAD') {
    response.end()
    return { served: true }
  }

  const stream = createReadStream(file)
  // A read that fails after the head is written cannot be turned into a status
  // code any more; destroying the socket is the only honest end, and it makes
  // the failure visible to the client instead of leaving it waiting.
  stream.on('error', (error) => {
    console.error('[web] could not read a static file', error)
    response.destroy()
  })
  stream.pipe(response)
  return { served: true }
}

/**
 * The file to send: the request's own, `index.html` inside a directory, or the
 * app document for a route that has no file behind it.
 */
function pickFile(target: string, pathname: string, root: string): string | null {
  const direct = statOrNull(target)
  if (direct?.isFile()) return target

  if (direct?.isDirectory()) {
    const index = join(target, 'index.html')
    if (statOrNull(index)?.isFile()) return index
  }

  // A missing *asset* is a 404 and not the document - see the note at the top.
  if (looksLikeAFile(pathname)) return null

  const index = join(root, 'index.html')
  return statOrNull(index)?.isFile() ? index : null
}

function statOrNull(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}
