/**
 * The `gitwarren:` scheme, which is how attachment images reach the renderer.
 *
 * A plain `file://` src cannot do this job, which is the whole reason a custom
 * scheme exists. Chromium refuses `file://` subresources from a page on another
 * origin, and the renderer's own origin differs between environments -
 * `http://localhost` under `electron-vite dev`, `file://` in a packaged build.
 * A custom scheme is identical in both, so markdown that renders an image in
 * development renders it in production.
 *
 * Kept in its own module rather than inline in `index.ts` because it is the one
 * piece of the main process that is a security boundary rather than lifecycle
 * wiring, and it is worth being able to exercise on its own.
 */
import { net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ATTACHMENT_FILE_NAME } from '../core/services/attachments.js'
import { isAnsweredLocally, route } from '../core/hosts/router.js'
import { getDataDirectory } from '../core/paths.js'
import { ATTACHMENT_HOST_PARAM } from '../shared/attachments.js'
import { AppError } from '../shared/errors.js'

/** The scheme, and the one host under it that resolves to anything. */
export const ATTACHMENT_SCHEME = 'gitwarren'
const ATTACHMENT_HOST = 'attachment'

/**
 * Declare the scheme's privileges. Must run before `app.whenReady()` - that is
 * the only point at which Chromium accepts them.
 *
 * `standard` gives the scheme an origin, which is what makes it usable as an
 * `<img>` source at all; `secure` keeps it out of the mixed-content rules; and
 * `stream` lets a large image arrive in pieces rather than being buffered whole.
 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, stream: true } }
  ])
}

/**
 * Answer a `gitwarren://attachment/<sha>.<ext>` request with the file.
 *
 * The name test is the security boundary here, and it is why the check is a
 * whitelist rather than a traversal filter. Comment bodies are agent-writable,
 * so this URL is reachable by anything an agent can put in a body - meaning
 * `gitwarren://attachment/../../../../etc/passwd` is a request this app will
 * genuinely receive one day. A sha and a short extension is the entire
 * vocabulary of a legitimate name, so anything else is refused outright rather
 * than being resolved and then reasoned about.
 *
 * ## Which machine's store
 *
 * Since M4.4 the URL may carry `?host=<instance>`, put there by the renderer
 * when the screen is about another machine (see `ATTACHMENT_HOST_PARAM`). The
 * decision of what that means is not made here: `isAnsweredLocally` is the
 * router's, so "no host", "our own instance id" and "somebody else's" mean
 * exactly what they mean for every other request, and this scheme cannot drift
 * from them.
 *
 * A remote image comes back as base64 on the answer and is turned into a
 * `Response` here rather than streamed. It is the one place this app buffers an
 * attachment whole, and the ingest limit is what makes that acceptable - a
 * range request over an `ssh` pipe would be a second protocol for the sake of
 * images that are already bounded at ten megabytes.
 */
export async function attachmentResponse(url: string): Promise<Response> {
  const { host, pathname, searchParams } = new URL(url)
  if (host !== ATTACHMENT_HOST) return new Response(null, { status: 404 })

  const name = pathname.slice(1)
  if (!ATTACHMENT_FILE_NAME.test(name)) return new Response(null, { status: 400 })

  const instance = searchParams.get(ATTACHMENT_HOST_PARAM) ?? undefined
  if (isAnsweredLocally(instance, 'attachments.read')) {
    const file = join(getDataDirectory(), 'attachments', name.slice(0, 2), name)
    return await net.fetch(pathToFileURL(file).toString())
  }

  try {
    const image = await route(instance, 'attachments.read', { name })
    return new Response(Buffer.from(image.base64, 'base64'), {
      headers: {
        'Content-Type': image.mimeType,
        // Content-addressed, so these bytes can never become different bytes.
        // Worth saying on this branch in particular: without it every re-render
        // of a comment would be another round trip over `ssh`.
        'Cache-Control': 'private, max-age=31536000, immutable'
      }
    })
  } catch (error) {
    // An `<img>` has nowhere to put a sentence, so the code is all that can be
    // said - and the reason is worth logging, because "the host is not
    // answering" and "that token is not in its store" look identical on screen.
    console.error(`[attachments] could not read ${name} from host ${instance}`, error)
    const missing = error instanceof AppError && error.code === 'NOT_FOUND'
    return new Response(null, { status: missing ? 404 : 502 })
  }
}

/** Wire the handler up. Call once, after the app is ready. */
export function registerAttachmentProtocol(): void {
  protocol.handle(ATTACHMENT_SCHEME, (request) => attachmentResponse(request.url))
}
