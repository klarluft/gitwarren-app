/**
 * Coverage for the attachment store.
 *
 * The interesting properties are not CRUD. They are that ingest converges when
 * it is run twice on the same bytes - because the GUI and the MCP server are
 * separate processes that can genuinely race - that the format is decided by
 * looking at the bytes rather than believing a filename, and that the name the
 * protocol handler will serve cannot be talked into pointing outside the store.
 *
 * That last one is a real boundary rather than a formality: a comment body is
 * agent-writable, so `gitwarren://attachment/../../../../etc/passwd` is a URL
 * this app will be asked for one day.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../shared/errors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-attachment-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-attachment-work-'))
process.env.GITWARREN_DATA_DIR = dataDir

const {
  attachmentsService,
  attachmentPath,
  parseAttachmentUrl,
  ATTACHMENT_FILE_NAME,
  MAX_ATTACHMENT_BYTES
} = await import('../services/attachments.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { attachments, comments, commentThreads, repositories, reviews } = await import(
  '../db/schema.js'
)
const { AppError } = await import('../../shared/errors.js')

/**
 * The smallest real PNG: an 8-byte signature, an IHDR naming the dimensions,
 * and enough of a body that reading the header cannot run off the end.
 */
function png(width = 1, height = 1, filler = 0): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  // A trailing byte, so two images of the same size can still differ.
  return Buffer.concat([header, ihdr, Buffer.from([filler])])
}

function jpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(20),
    // A SOF0 frame header carrying 480x640.
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80]),
    Buffer.alloc(10)
  ])
}

function gif(): Buffer {
  const bytes = Buffer.alloc(20)
  bytes.write('GIF89a', 0, 'latin1')
  bytes.writeUInt16LE(300, 6)
  bytes.writeUInt16LE(200, 8)
  return bytes
}

async function expectError(code: string, fn: () => Promise<unknown>): Promise<AppErrorInstance> {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  throw new Error(`expected the call to reject with ${code}`)
}

beforeEach(() => {
  getDatabase().delete(comments).run()
  getDatabase().delete(commentThreads).run()
  getDatabase().delete(reviews).run()
  getDatabase().delete(repositories).run()
  getDatabase().delete(attachments).run()
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

test('the same bytes ingest to the same row and file, however many times', async () => {
  // The property the two-process design rests on: the GUI and the MCP server
  // can ingest the same image concurrently and must converge rather than
  // collide, which content addressing gives for free.
  const bytes = png(4, 3)

  const first = await attachmentsService.ingest({ bytes, originalName: 'shot.png' })
  const second = await attachmentsService.ingest({ bytes, originalName: 'different-name.png' })

  assert.equal(first.sha, second.sha)
  assert.equal(first.url, second.url)
  assert.equal(first.path, second.path)
  assert.equal(getDatabase().select().from(attachments).all().length, 1)
  assert.ok(existsSync(first.path))
})

test('two different images do not collide', async () => {
  const first = await attachmentsService.ingest({ bytes: png(1, 1, 0) })
  const second = await attachmentsService.ingest({ bytes: png(1, 1, 9) })

  assert.notEqual(first.sha, second.sha)
  assert.equal(getDatabase().select().from(attachments).all().length, 2)
})

test('the format comes from the bytes, not from the filename', async () => {
  // A JPEG announced as a PNG is stored as what it actually is. Believing the
  // extension is how a file ends up served under a type it is not.
  const stored = await attachmentsService.ingest({ bytes: jpeg(), originalName: 'screenshot.png' })

  assert.equal(stored.mimeType, 'image/jpeg')
  assert.ok(stored.url.endsWith('.jpg'))
  assert.equal(stored.originalName, 'screenshot.png')
})

test('dimensions are read from the header, per format', async () => {
  const asPng = await attachmentsService.ingest({ bytes: png(1284, 818) })
  assert.deepEqual([asPng.width, asPng.height], [1284, 818])

  const asJpeg = await attachmentsService.ingest({ bytes: jpeg() })
  assert.deepEqual([asJpeg.width, asJpeg.height], [640, 480])

  const asGif = await attachmentsService.ingest({ bytes: gif() })
  assert.deepEqual([asGif.width, asGif.height], [300, 200])
})

test('a non-image is refused', async () => {
  await expectError('INVALID_INPUT', () =>
    attachmentsService.ingest({ bytes: Buffer.from('this is just text'), originalName: 'notes.png' })
  )
  assert.equal(getDatabase().select().from(attachments).all().length, 0)
})

test('an SVG is refused, even though a browser would render it', async () => {
  // Excluded on purpose: it is a script-bearing document rather than a raster
  // image, and it is not what anyone pastes into a code review.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

  await expectError('INVALID_INPUT', () =>
    attachmentsService.ingest({ bytes: svg, originalName: 'diagram.svg' })
  )
})

test('the size cap is enforced', async () => {
  const huge = Buffer.concat([png(), Buffer.alloc(MAX_ATTACHMENT_BYTES)])

  await expectError('INVALID_INPUT', () => attachmentsService.ingest({ bytes: huge }))
  assert.equal(getDatabase().select().from(attachments).all().length, 0)
})

test('an oversized file on disk is refused before it is read', async () => {
  // Checked from the stat rather than after loading, so a wrong file cannot be
  // pulled into memory on its way to being rejected.
  const path = join(workDir, 'huge.png')
  writeFileSync(path, Buffer.concat([png(), Buffer.alloc(MAX_ATTACHMENT_BYTES)]))

  await expectError('INVALID_INPUT', () => attachmentsService.ingest({ path }))
})

test('a path that does not exist reports PATH_NOT_FOUND', async () => {
  await expectError('PATH_NOT_FOUND', () =>
    attachmentsService.ingest({ path: join(workDir, 'nothing-here.png') })
  )
})

test('ingesting from a path stores the bytes and remembers the filename', async () => {
  const path = join(workDir, 'dropdown-bug.png')
  writeFileSync(path, png(12, 8))

  const stored = await attachmentsService.ingest({ path })

  assert.equal(stored.originalName, 'dropdown-bug.png')
  assert.deepEqual([stored.width, stored.height], [12, 8])
  assert.deepEqual(readFileSync(stored.path), png(12, 8))
})

/* -------------------------------------------------------------------------- */
/* The protocol filename                                                      */
/* -------------------------------------------------------------------------- */

test('only a sha and a short extension are servable names', () => {
  const sha = 'a'.repeat(64)
  assert.ok(ATTACHMENT_FILE_NAME.test(`${sha}.png`))
  assert.ok(ATTACHMENT_FILE_NAME.test(`${sha}.jpg`))
  assert.ok(ATTACHMENT_FILE_NAME.test(`${sha}.webp`))
})

test('traversal attempts are refused by the name test, not resolved and checked', () => {
  // This expression is the security boundary in the protocol handler. Every one
  // of these is a string an agent can put in a comment body.
  const rejected = [
    '../../../../etc/passwd',
    `${'a'.repeat(64)}.png/../../../../etc/passwd`,
    `..%2f..%2f${'a'.repeat(64)}.png`,
    `${'a'.repeat(63)}.png`,
    `${'a'.repeat(65)}.png`,
    // Upper case hex is not what the store ever writes, so it is not accepted.
    `${'A'.repeat(64)}.png`,
    // Four characters is the ceiling because of "webp"; five is not a format.
    `${'a'.repeat(64)}.jpegg`,
    `${'a'.repeat(64)}`,
    `${'g'.repeat(64)}.png`,
    `${'a'.repeat(64)}.png\n${'b'.repeat(64)}.png`,
    ''
  ]

  for (const name of rejected) {
    assert.equal(ATTACHMENT_FILE_NAME.test(name), false, `should have refused ${JSON.stringify(name)}`)
  }
})

test('a token round-trips to the same file the store wrote', async () => {
  const stored = await attachmentsService.ingest({ bytes: png(2, 2) })
  const parsed = parseAttachmentUrl(stored.url)

  assert.ok(parsed)
  assert.equal(parsed.sha, stored.sha)
  assert.equal(attachmentPath(parsed.sha, parsed.ext), stored.path)
})

test('a token that is not one parses to null', () => {
  assert.equal(parseAttachmentUrl('https://example.com/a.png'), null)
  assert.equal(parseAttachmentUrl('gitwarren://attachment/../../etc/passwd'), null)
  assert.equal(parseAttachmentUrl('gitwarren://other/aaa.png'), null)
})

/* -------------------------------------------------------------------------- */
/* Sweeping                                                                   */
/* -------------------------------------------------------------------------- */

test('an attachment no body mentions is swept, and its file goes with it', async () => {
  const orphan = await attachmentsService.ingest({ bytes: png(5, 5) })
  assert.ok(existsSync(orphan.path))

  const { removed } = await attachmentsService.sweep()

  assert.equal(removed, 1)
  assert.equal(existsSync(orphan.path), false)
  assert.equal(getDatabase().select().from(attachments).all().length, 0)
})

test('an attachment a comment refers to survives the sweep', async () => {
  const kept = await attachmentsService.ingest({ bytes: png(6, 6) })
  const orphan = await attachmentsService.ingest({ bytes: png(7, 7) })

  const repository = getDatabase()
    .insert(repositories)
    .values({ path: join(workDir, 'repo'), name: 'repo' })
    .returning()
    .get()
  const review = getDatabase()
    .insert(reviews)
    .values({ repositoryId: repository.id, title: 'r', baseRef: 'main', headRef: 'feature' })
    .returning()
    .get()
  const thread = getDatabase()
    .insert(commentThreads)
    .values({ reviewId: review.id })
    .returning()
    .get()
  getDatabase()
    .insert(comments)
    .values({
      threadId: thread.id,
      authorKind: 'human',
      authorName: 'Human',
      body: `Look at this:\n\n![the bug](${kept.url})`
    })
    .run()

  const { removed } = await attachmentsService.sweep()

  assert.equal(removed, 1)
  assert.ok(existsSync(kept.path))
  assert.equal(existsSync(orphan.path), false)
})

test('a review description counts as a reference too', async () => {
  const kept = await attachmentsService.ingest({ bytes: png(8, 8) })

  const repository = getDatabase()
    .insert(repositories)
    .values({ path: join(workDir, 'repo2'), name: 'repo2' })
    .returning()
    .get()
  getDatabase()
    .insert(reviews)
    .values({
      repositoryId: repository.id,
      title: 'r',
      description: `Before and after: ![after](${kept.url})`,
      baseRef: 'main',
      headRef: 'feature'
    })
    .run()

  const { removed } = await attachmentsService.sweep()

  assert.equal(removed, 0)
  assert.ok(existsSync(kept.path))
})
