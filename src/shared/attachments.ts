/**
 * The attachment token: how an image is named in a comment body.
 *
 * A body never holds a filesystem path. It holds
 * `gitwarren://attachment/<sha256>.<ext>`, and the bytes live in a
 * content-addressed store the app owns - see `core/services/attachments.ts` for
 * why copying is the only shape that works. What lives *here* is only the
 * grammar of that token, because by M3.2 four unrelated worlds have to agree on
 * it:
 *
 *  - the store, which mints one (Node);
 *  - the Electron main process, which serves it over a custom scheme (Node);
 *  - the loopback server, which serves it over HTTP (Node);
 *  - the renderer, which puts it in an `<img src>` (a browser bundle).
 *
 * The last one is why this is `shared/` rather than an export of the service:
 * the service reaches for `node:crypto` and `node:fs` on its first line, and a
 * browser cannot import it to learn what a token looks like. The grammar is a
 * handful of characters and no behaviour, so it moves here and the service
 * keeps re-exporting it.
 *
 * Plain JS only. No Node, no Electron.
 */

/** The URL scheme and host an attachment is named by. */
export const ATTACHMENT_URL_PREFIX = 'gitwarren://attachment/'

/**
 * Filenames anything serving attachments will accept.
 *
 * This is a security boundary rather than a tidiness check, and it is why the
 * expression is a whitelist rather than a traversal filter. Comment bodies are
 * agent-writable, so `gitwarren://attachment/../../../../etc/passwd` is a URL
 * that will genuinely be requested one day - over the custom scheme in the app,
 * and now over HTTP in a browser tab too. A hash and a short extension is the
 * entire vocabulary of a legitimate name, so anything else is refused outright
 * rather than resolved and then reasoned about.
 */
export const ATTACHMENT_FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{2,4}$/

export function attachmentUrl(sha: string, ext: string): string {
  return `${ATTACHMENT_URL_PREFIX}${sha}.${ext}`
}

/**
 * The `<sha>.<ext>` a token names, or null when the URL is not one of ours.
 *
 * Separate from `parseAttachmentUrl` because whoever is *serving* the file
 * wants the name back as a name - it is a path segment and a filename in the
 * store, and splitting it into two halves only to join them again is where a
 * `.` goes missing.
 */
export function attachmentName(url: string): string | null {
  if (!url.startsWith(ATTACHMENT_URL_PREFIX)) return null
  const name = url.slice(ATTACHMENT_URL_PREFIX.length)
  return ATTACHMENT_FILE_NAME.test(name) ? name : null
}

/** Pull the `<sha>.<ext>` out of a token, or null if it is not one. */
export function parseAttachmentUrl(url: string): { sha: string; ext: string } | null {
  const name = attachmentName(url)
  if (name === null) return null
  const dot = name.lastIndexOf('.')
  return { sha: name.slice(0, dot), ext: name.slice(dot + 1) }
}
