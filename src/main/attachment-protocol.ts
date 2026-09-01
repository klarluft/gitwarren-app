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
import { getDataDirectory } from '../core/paths.js'

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
 */
export function attachmentResponse(url: string): Response | Promise<Response> {
  const { host, pathname } = new URL(url)
  if (host !== ATTACHMENT_HOST) return new Response(null, { status: 404 })

  const name = pathname.slice(1)
  if (!ATTACHMENT_FILE_NAME.test(name)) return new Response(null, { status: 400 })

  const file = join(getDataDirectory(), 'attachments', name.slice(0, 2), name)
  return net.fetch(pathToFileURL(file).toString())
}

/** Wire the handler up. Call once, after the app is ready. */
export function registerAttachmentProtocol(): void {
  protocol.handle(ATTACHMENT_SCHEME, (request) => attachmentResponse(request.url))
}
