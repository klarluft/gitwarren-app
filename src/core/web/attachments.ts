/**
 * Attachment bytes over HTTP, for the shell that has no custom scheme.
 *
 * The Electron window serves these through `gitwarren://attachment/…`, which a
 * browser tab cannot register and would not be allowed to fetch if it could.
 * This is the same store, the same names and the same whitelist, answered on
 * the loopback origin the tab was already served from - which is also why the
 * renderer's `img-src 'self'` covers it without a new source being added to the
 * policy.
 *
 * ## What makes this safe to point at a directory
 *
 * Nothing here builds a path out of a URL. The name is matched against
 * `ATTACHMENT_FILE_NAME` first - 64 hex characters, a dot, a short extension -
 * and only a name that *is* that is handed to `attachmentPath`, which does the
 * sharding itself. So there is no traversal to defend against rather than a
 * traversal defended against: `..`, an encoded separator and a Windows `\` all
 * fail the pattern before any filesystem call happens. That is the same
 * reasoning `main/attachment-protocol.ts` states, and it matters for the same
 * reason - comment bodies are written by agents, and an agent may have just
 * read untrusted content out of the repository under review.
 *
 * The content type comes from the extension, which is not the usual mistake:
 * the extension was chosen at ingest by sniffing the bytes (see
 * `core/services/attachments.ts`), so it is this app's own conclusion about the
 * file rather than a claim made by whoever supplied it. An extension that is
 * somehow not one of the four is refused instead of being served as
 * `application/octet-stream`, because the only thing that reads this endpoint
 * is an `<img>`.
 */
import { createReadStream, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { attachmentPath } from '../services/attachments.js'
import { attachmentNameFromWebPath, WEB_PATHS } from '../../shared/web.js'

/**
 * The formats the store can hold, and nothing else.
 *
 * Kept in step with `FORMATS` in the store by being smaller than it: a format
 * that can be ingested but not listed here would 404 rather than be served as
 * the wrong type, which is the failure worth having.
 */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  /**
   * Content-addressed, so the bytes behind a name can never change: the name is
   * the hash of them. `private` rather than `public` because a shared cache has
   * no business holding a review's screenshots, even though on loopback there
   * is not one.
   */
  'Cache-Control': 'private, max-age=31536000, immutable'
} as const

export interface AttachmentResult {
  /** False when the path was not an attachment at all - not when it was missing. */
  served: boolean
}

/**
 * Answer a request under the attachments prefix.
 *
 * A path that is not one is left alone (`served: false`) so the caller can go
 * on routing. A path that *is* one is always answered here, including when the
 * name is malformed or the file has been swept away - those are this endpoint's
 * own 400 and 404 rather than the caller's.
 */
export function serveAttachment(
  pathname: string,
  method: string,
  response: ServerResponse
): AttachmentResult {
  if (!pathname.startsWith(WEB_PATHS.attachments)) return { served: false }

  const name = attachmentNameFromWebPath(pathname)
  if (name === null) {
    response.writeHead(400, HEADERS).end()
    return { served: true }
  }

  const dot = name.lastIndexOf('.')
  const contentType = CONTENT_TYPES[name.slice(dot + 1)]
  if (contentType === undefined) {
    response.writeHead(404, HEADERS).end()
    return { served: true }
  }

  const file = attachmentPath(name.slice(0, dot), name.slice(dot + 1))
  let size: number
  try {
    const stats = statSync(file)
    if (!stats.isFile()) throw new Error('not a file')
    size = stats.size
  } catch {
    // A token whose bytes the sweep has already collected. The comment still
    // refers to it, so this happens in ordinary use and is not worth logging.
    response.writeHead(404, HEADERS).end()
    return { served: true }
  }

  response.writeHead(200, { ...HEADERS, 'Content-Type': contentType, 'Content-Length': size })

  if (method === 'HEAD') {
    response.end()
    return { served: true }
  }

  const stream = createReadStream(file)
  // Past the head there is no status code left to send; destroying the socket
  // is the only honest end, and it makes the failure visible to the browser
  // rather than leaving it waiting on a half-written image.
  stream.on('error', (error) => {
    console.error('[web] could not read an attachment', error)
    response.destroy()
  })
  stream.pipe(response)
  return { served: true }
}
