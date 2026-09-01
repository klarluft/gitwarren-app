/**
 * The attachment store: copying an image into the app, and forgetting it again.
 *
 * A comment body never holds a filesystem path. It holds an opaque token,
 * `gitwarren://attachment/<sha256>.<ext>`, and the bytes live in a
 * content-addressed store under the app's data directory. Three facts force
 * that shape, and each of them rules out something simpler:
 *
 *  - **A pasted screenshot has no path, only bytes.** So there has to be a
 *    copy-into-the-app step somewhere; referencing paths alone cannot express
 *    the single most common way an image gets into a code review.
 *  - **Ephemeral paths die.** An agent writes to /tmp, and /tmp is purged; a
 *    Playwright screenshot lands in `test-results/`, which is wiped at the
 *    start of the next run. Copying is what lets the discussion outlive the
 *    file - the same principle `anchorSnapshot` exists to serve.
 *  - **Agents cannot upload.** Handing base64 to a tool call means *emitting*
 *    around 550K characters for a 400KB screenshot. Agents pass paths, and this
 *    service is what turns a path into something durable.
 *
 * Content addressing is not an optimisation here, it is the concurrency story.
 * The GUI and the MCP server are separate processes on one SQLite file, so two
 * ingests of the same bytes can genuinely race; keying on the hash makes the
 * write idempotent, so they converge instead of colliding.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import { attachments, comments, reviews } from '../db/schema.js'
import { getDataDirectory } from '../paths.js'
import { AppError } from '../../shared/errors.js'
import type { Attachment } from '../../shared/schemas.js'

/**
 * The ceiling on a single attachment.
 *
 * Checked *before* the bytes are copied, so a wrong file cannot fill the data
 * directory on its way to being rejected. Ten megabytes is far above any
 * screenshot and far below anything that would make the store a problem.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** The URL scheme and host the renderer fetches attachments through. */
export const ATTACHMENT_URL_PREFIX = 'gitwarren://attachment/'

/**
 * Filenames the custom protocol will serve.
 *
 * Exported because the protocol handler in the main process tests against this
 * exact expression, and it is the security boundary there: comment bodies are
 * agent-writable, so `gitwarren://attachment/../../../../etc/passwd` is a URL
 * that will genuinely be requested one day. A hash and a short extension is the
 * entire vocabulary of a legitimate name, so anything else is refused rather
 * than resolved and checked.
 */
export const ATTACHMENT_FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{2,4}$/

interface ImageFormat {
  ext: string
  mimeType: string
  /** True when `bytes` begins with this format's signature. */
  matches: (bytes: Buffer) => boolean
}

/**
 * Format detection by magic bytes, never by filename.
 *
 * A filename is a claim made by whoever supplied the file; the first bytes are
 * what the browser will actually act on when it renders the `<img>`. Trusting
 * the extension is how you end up storing something as `.png` that is not one.
 *
 * SVG is deliberately absent. It is a script-bearing document rather than a
 * raster image, it is not what anyone is pasting into a code review, and
 * excluding it is cheaper than reasoning about what a sanitiser would have to
 * strip. A hand-rolled sniffer rather than a dependency: this is four formats
 * and about a dozen bytes, and the dependency list is kept short on purpose.
 */
const FORMATS: ImageFormat[] = [
  {
    ext: 'png',
    mimeType: 'image/png',
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
  },
  {
    ext: 'jpg',
    mimeType: 'image/jpeg',
    matches: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  },
  {
    ext: 'gif',
    mimeType: 'image/gif',
    // "GIF87a" or "GIF89a".
    matches: (bytes) => bytes.length >= 6 && bytes.subarray(0, 3).toString('latin1') === 'GIF'
  },
  {
    ext: 'webp',
    mimeType: 'image/webp',
    // RIFF container, with "WEBP" as the form type four bytes after the size.
    matches: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  }
]

function sniff(bytes: Buffer): ImageFormat | null {
  return FORMATS.find((format) => format.matches(bytes)) ?? null
}

/** Pixel dimensions, when they can be read from the header cheaply. */
function readDimensions(
  bytes: Buffer,
  ext: string
): { width: number | null; height: number | null } {
  try {
    if (ext === 'png') {
      // IHDR is always the first chunk, and its width/height sit at a fixed offset.
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }
    if (ext === 'gif') {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
    }
    if (ext === 'jpg') return readJpegDimensions(bytes)
    if (ext === 'webp') return readWebpDimensions(bytes)
  } catch {
    // Dimensions are a nicety - they drive layout and tell an agent what it is
    // about to open. A malformed header is not a reason to refuse the image.
  }
  return { width: null, height: null }
}

/**
 * Walk a JPEG's segment chain to the frame header that carries the size.
 *
 * Unlike PNG there is no fixed offset: the dimensions live in whichever SOFn
 * marker the encoder emitted, after any number of variable-length segments.
 */
function readJpegDimensions(bytes: Buffer): { width: number | null; height: number | null } {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) break
    // SOF0..SOF15, excluding the four markers in that range that are not frame
    // headers (DHT, JPGA, DAC, RSTn).
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + bytes.readUInt16BE(offset + 2)
  }
  return { width: null, height: null }
}

/** WebP comes in three chunk layouts, and each stores its size differently. */
function readWebpDimensions(bytes: Buffer): { width: number | null; height: number | null } {
  const chunk = bytes.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8X') {
    return {
      width: 1 + (bytes.readUIntLE(24, 3) & 0xffffff),
      height: 1 + (bytes.readUIntLE(27, 3) & 0xffffff)
    }
  }
  if (chunk === 'VP8 ') {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  return { width: null, height: null }
}

export type AttachmentSource = { bytes: Buffer; originalName?: string } | { path: string }

function attachmentsRoot(): string {
  return join(getDataDirectory(), 'attachments')
}

/** Where the bytes for `<sha>.<ext>` live. Sharded so no directory grows huge. */
export function attachmentPath(sha: string, ext: string): string {
  return join(attachmentsRoot(), sha.slice(0, 2), `${sha}.${ext}`)
}

export function attachmentUrl(sha: string, ext: string): string {
  return `${ATTACHMENT_URL_PREFIX}${sha}.${ext}`
}

/** Pull the `<sha>.<ext>` out of a token, or null if it is not one. */
export function parseAttachmentUrl(url: string): { sha: string; ext: string } | null {
  if (!url.startsWith(ATTACHMENT_URL_PREFIX)) return null
  const name = url.slice(ATTACHMENT_URL_PREFIX.length)
  if (!ATTACHMENT_FILE_NAME.test(name)) return null
  const dot = name.lastIndexOf('.')
  return { sha: name.slice(0, dot), ext: name.slice(dot + 1) }
}

function toAttachment(row: {
  sha: string
  ext: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  originalName: string | null
}): Attachment {
  return {
    sha: row.sha,
    url: attachmentUrl(row.sha, row.ext),
    path: attachmentPath(row.sha, row.ext),
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    originalName: row.originalName
  }
}

/** Every `gitwarren://attachment/` token appearing anywhere in a body. */
function tokensIn(body: string): string[] {
  const found = body.match(/gitwarren:\/\/attachment\/[a-f0-9]{64}\.[a-z0-9]{2,4}/g)
  return found ?? []
}

export const attachmentsService = {
  /**
   * Copy an image into the store and return the token for it.
   *
   * Accepts bytes (the clipboard) or a path (an agent, or a file picker). Both
   * end in the same place; only the moment differs. The UI ingests at paste
   * time, so the preview can draw the real image before the comment is even
   * submitted, while an agent's images are ingested at save time because the
   * agent hands over a path inside a body it has already written.
   *
   * Safe to run twice, and safe to run concurrently from both processes: the
   * name is derived from the bytes, the write goes through a temporary file so
   * a reader never sees a half-written image, and the row insert ignores a
   * conflict rather than treating "already there" as a failure.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async ingest(source: AttachmentSource): Promise<Attachment> {
    let bytes: Buffer
    let originalName: string | null

    if ('bytes' in source) {
      bytes = source.bytes
      originalName = source.originalName ?? null
    } else {
      let size: number
      try {
        const stats = statSync(source.path)
        if (!stats.isFile()) {
          throw new AppError('INVALID_INPUT', `${source.path} is not a file.`)
        }
        size = stats.size
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError('PATH_NOT_FOUND', `No file at ${source.path}.`)
      }
      // Checked from the stat rather than after reading, so an enormous file is
      // refused without ever being pulled into memory.
      if (size > MAX_ATTACHMENT_BYTES) {
        throw new AppError(
          'INVALID_INPUT',
          `That file is ${Math.round(size / 1024 / 1024)} MB. Attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`
        )
      }
      bytes = readFileSync(source.path)
      originalName = source.path.split(/[\\/]/).pop() ?? null
    }

    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AppError(
        'INVALID_INPUT',
        `That image is ${Math.round(bytes.byteLength / 1024 / 1024)} MB. Attachments are limited to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`
      )
    }

    const format = sniff(bytes)
    if (!format) {
      throw new AppError(
        'INVALID_INPUT',
        'That file is not a PNG, JPEG, GIF or WebP image. (SVG is not accepted.)'
      )
    }

    const sha = createHash('sha256').update(bytes).digest('hex')
    const target = attachmentPath(sha, format.ext)

    mkdirSync(join(attachmentsRoot(), sha.slice(0, 2)), { recursive: true })
    // Written under a unique name and renamed into place. The rename is atomic
    // within a directory, so a concurrent reader either sees no file or sees
    // the whole of it - never the first half of a screenshot.
    if (!existsQuietly(target)) {
      const staging = `${target}.${process.pid}.${Date.now()}.part`
      writeFileSync(staging, bytes)
      renameSync(staging, target)
    }

    const { width, height } = readDimensions(bytes, format.ext)

    getDatabase()
      .insert(attachments)
      .values({
        sha,
        ext: format.ext,
        mimeType: format.mimeType,
        byteSize: bytes.byteLength,
        width,
        height,
        originalName
      })
      .onConflictDoNothing()
      .run()

    return toAttachment({
      sha,
      ext: format.ext,
      mimeType: format.mimeType,
      byteSize: bytes.byteLength,
      width,
      height,
      originalName
    })
  },

  /**
   * Delete every attachment no body refers to any more.
   *
   * A sweep rather than reference counting, for two reasons. Bodies are short
   * text and there are at most a few thousand rows, so a full scan costs
   * nothing at this scale and cannot drift out of sync the way a counter can.
   * And it handles the case a counter cannot express: the UI ingests a pasted
   * image *before* the comment is submitted, so an abandoned composer
   * legitimately leaves an orphan behind that was never referenced by anything.
   *
   * Called once at startup, and only from the GUI process - never from the MCP
   * server, which may be one of several concurrent processes and could be
   * sweeping away an image the GUI has just ingested but not yet saved.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async sweep(): Promise<{ removed: number }> {
    const db = getDatabase()

    const referenced = new Set<string>()
    for (const { body } of db.select({ body: comments.body }).from(comments).all()) {
      for (const token of tokensIn(body)) {
        const parsed = parseAttachmentUrl(token)
        if (parsed) referenced.add(parsed.sha)
      }
    }
    for (const { description } of db
      .select({ description: reviews.description })
      .from(reviews)
      .all()) {
      for (const token of tokensIn(description)) {
        const parsed = parseAttachmentUrl(token)
        if (parsed) referenced.add(parsed.sha)
      }
    }

    let removed = 0
    for (const row of db.select().from(attachments).all()) {
      if (referenced.has(row.sha)) continue
      // The row goes first. If the unlink fails - a permission problem, a file
      // already gone - the result is a file nobody points at, which the next
      // sweep will not even look for. The reverse order could leave a row
      // promising an image that is no longer on disk.
      db.delete(attachments).where(eq(attachments.sha, row.sha)).run()
      unlinkQuietly(attachmentPath(row.sha, row.ext))
      removed += 1
    }

    return { removed }
  }
}

export type AttachmentsService = typeof attachmentsService

/**
 * Look up several attachments by sha, for resolving the tokens in a body.
 *
 * Synchronous and outside the service because it is called from `toComment`,
 * which runs inside database transactions and has to stay sync. Callers gate on
 * the body containing a token at all, so a comment with no attachments - which
 * is nearly all of them - costs no query.
 */
export function attachmentsBySha(shas: string[]): Map<string, Attachment> {
  if (shas.length === 0) return new Map()
  const rows = getDatabase().select().from(attachments).where(inArray(attachments.sha, shas)).all()
  return new Map(rows.map((row) => [row.sha, toAttachment(row)]))
}

/* -------------------------------------------------------------------------- */

function existsQuietly(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or not ours to delete. Either way there is nothing useful
    // to do about it during a startup sweep.
  }
}
