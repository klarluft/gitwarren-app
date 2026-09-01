/**
 * Coverage for rewriting a body's local image paths into attachment tokens.
 *
 * Every test here is about one of the three ways this can go quietly wrong.
 *
 * It can ingest something it should not have: an image inside a fenced code
 * block is an *example*, and agents write those constantly - this app's own
 * tool descriptions contain one. Parsing the markdown rather than matching it
 * is what makes that safe, so there is a test that would fail for any regex.
 *
 * It can damage the body on the way through. Re-serialising the parsed tree
 * would normalise bullet markers, emphasis characters and line wrapping, so the
 * assertions below check the body is byte-identical apart from the URLs, not
 * merely that it still means the same thing.
 *
 * And it can throw away a comment over a detail. A path that does not resolve
 * must leave the text alone and let the comment save - failing the whole call
 * would discard a body an agent spent real tokens composing.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-ingest-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-ingest-work-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { ingestBodyAttachments, localPathFor } = await import('../attachment-ingest.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { attachments } = await import('../db/schema.js')

function png(filler = 0): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(10, 8)
  ihdr.writeUInt32BE(10, 12)
  return Buffer.concat([header, ihdr, Buffer.from([filler])])
}

/** Write an image into the scratch directory and return its path. */
function image(name: string, filler = 0): string {
  const path = join(workDir, name)
  mkdirSync(join(workDir), { recursive: true })
  writeFileSync(path, png(filler))
  return path
}

const TOKEN = /gitwarren:\/\/attachment\/[a-f0-9]{64}\.png/

beforeEach(() => {
  getDatabase().delete(attachments).run()
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* What gets ingested                                                         */
/* -------------------------------------------------------------------------- */

test('a local image path is ingested and its URL replaced', async () => {
  const path = image('shot.png')
  const body = `The dropdown renders behind the modal:\n\n![dropdown behind modal](${path})`

  const rewritten = await ingestBodyAttachments(body)

  assert.match(rewritten, TOKEN)
  assert.doesNotMatch(rewritten, /shot\.png/)
  // The alt text is the agent's description of the picture, and is the only
  // thing a reader without vision gets. It must survive untouched.
  assert.match(rewritten, /!\[dropdown behind modal\]/)
  assert.equal(getDatabase().select().from(attachments).all().length, 1)
})

test('an image inside a fenced code block is NOT ingested', async () => {
  // The case that decides parse-versus-regex. An agent writing documentation
  // about how to attach an image must not thereby attach one.
  const path = image('example.png')
  const body = [
    'To include a screenshot, reference it as a markdown image:',
    '',
    '```markdown',
    `![dropdown behind modal](${path})`,
    '```',
    '',
    'That is all there is to it.'
  ].join('\n')

  const rewritten = await ingestBodyAttachments(body)

  assert.equal(rewritten, body)
  assert.equal(getDatabase().select().from(attachments).all().length, 0)
})

test('an image in an indented code block is NOT ingested either', async () => {
  const path = image('indented.png')
  const body = `Write it like this:\n\n    ![alt](${path})\n`

  const rewritten = await ingestBodyAttachments(body)

  assert.equal(rewritten, body)
  assert.equal(getDatabase().select().from(attachments).all().length, 0)
})

test('an inline code span is not an image either', async () => {
  const path = image('span.png')
  const body = `Reference it as \`![alt](${path})\` in the body.`

  assert.equal(await ingestBodyAttachments(body), body)
})

test('a missing path is left untouched and does not throw', async () => {
  // The comment is worth more than the link. An agent cannot usefully retry
  // this, and failing would discard the whole body.
  const body = `Here is the failure:\n\n![gone](${join(workDir, 'never-existed.png')})`

  const rewritten = await ingestBodyAttachments(body)

  assert.equal(rewritten, body)
})

test('a path that is not an image is left untouched', async () => {
  const path = join(workDir, 'notes.png')
  writeFileSync(path, 'plain text pretending to be a png')

  const body = `![notes](${path})`

  assert.equal(await ingestBodyAttachments(body), body)
})

test('a remote URL is left alone', async () => {
  const body = '![remote](https://example.com/screenshot.png)'

  assert.equal(await ingestBodyAttachments(body), body)
})

test('a relative path is left alone - there is no working directory to trust', async () => {
  // The GUI's cwd is wherever the app was launched from and the MCP server's is
  // the agent's, so resolving one would ingest an unpredictable file.
  const body = '![docs](docs/architecture.png)'

  assert.equal(await ingestBodyAttachments(body), body)
})

test('a path inside the review repository is left alone', async () => {
  // Committed files are git's, and rendering them live is consistent with the
  // app's read-from-git-every-time rule. Copying one would freeze a picture of
  // a file that is under version control and expected to change.
  const repositoryRoot = join(workDir, 'project')
  mkdirSync(repositoryRoot, { recursive: true })
  const path = join(repositoryRoot, 'diagram.png')
  writeFileSync(path, png(3))

  const body = `![architecture](${path})`

  assert.equal(await ingestBodyAttachments(body, { repositoryRoot }), body)
  assert.equal(getDatabase().select().from(attachments).all().length, 0)
})

test('a body already holding a token is unchanged, so saving twice is safe', async () => {
  const path = image('twice.png')
  const once = await ingestBodyAttachments(`![shot](${path})`)

  assert.equal(await ingestBodyAttachments(once), once)
})

/* -------------------------------------------------------------------------- */
/* How the body is rewritten                                                  */
/* -------------------------------------------------------------------------- */

test('two images are both replaced, and the body is otherwise byte-identical', async () => {
  // Working backwards from the last match is what keeps the earlier offsets
  // valid; forwards, the second splice would land in the wrong place.
  const first = image('first.png', 1)
  const second = image('second.png', 2)

  const body = [
    '# Two problems',
    '',
    'The *dropdown* renders behind the modal:',
    '',
    `![dropdown behind modal](${first})`,
    '',
    '* and the toolbar wraps at 900px:',
    '',
    `![toolbar wrapping](${second})`,
    '',
    '> Both are in `header.tsx`.',
    ''
  ].join('\n')

  const rewritten = await ingestBodyAttachments(body)

  const tokens = rewritten.match(new RegExp(TOKEN.source, 'g')) ?? []
  assert.equal(tokens.length, 2)
  const [firstToken, secondToken] = tokens
  assert.ok(firstToken !== undefined && secondToken !== undefined)
  assert.notEqual(firstToken, secondToken)

  // Everything that is not a URL is preserved exactly - the heading, the
  // asterisk bullet that a re-serialiser would rewrite to a dash, the
  // underscores, the blockquote and the trailing newline.
  const restored = rewritten.replace(firstToken, first).replace(secondToken, second)
  assert.equal(restored, body)
})

test('alt text, titles and surrounding text survive the splice', async () => {
  const path = image('titled.png', 4)
  const body = `Look: ![the *bug*](${path} "hover text") - see it?`

  const rewritten = await ingestBodyAttachments(body)
  const token = TOKEN.exec(rewritten)?.[0]

  assert.ok(token)
  assert.equal(rewritten, `Look: ![the *bug*](${token} "hover text") - see it?`)
})

test('one bad path among good ones does not stop the others', async () => {
  const good = image('good.png', 5)
  const body = [
    `![missing](${join(workDir, 'absent.png')})`,
    '',
    `![good](${good})`
  ].join('\n')

  const rewritten = await ingestBodyAttachments(body)

  assert.match(rewritten, TOKEN)
  assert.match(rewritten, /absent\.png/)
})

test('a body with no images is returned without being parsed at all', async () => {
  const body = 'Just prose, with a `code span` and a [link](https://example.com).'

  assert.equal(await ingestBodyAttachments(body), body)
})

/* -------------------------------------------------------------------------- */
/* Resolving a URL to a path                                                  */
/* -------------------------------------------------------------------------- */

test('a file:// URL with percent-encoded spaces resolves', async () => {
  // How a macOS screenshot actually arrives: "Screen Shot 2026-09-01.png".
  const path = image('Screen Shot 2026-09-01.png', 6)
  const url = pathToFileURL(path).toString()

  assert.match(url, /%20/)
  assert.equal(localPathFor(url), path)

  const rewritten = await ingestBodyAttachments(`![shot](${url})`)
  assert.match(rewritten, TOKEN)
})

test('a bare path with percent-encoded spaces resolves too', () => {
  // Agents write both spellings, so both are accepted.
  const path = join(workDir, 'a file.png')
  assert.equal(localPathFor(path.replace(/ /g, '%20')), path)
})

test('an angle-bracketed path with raw spaces is ingested', async () => {
  // The spelling markdown provides for destinations containing spaces, and the
  // one the MCP tool description tells agents to use for macOS screenshots.
  const path = image('Screen Shot 2026-09-01 at 10.32.14.png', 7)

  const rewritten = await ingestBodyAttachments(`![login screen](<${path}>)`)

  assert.match(rewritten, TOKEN)
  // The brackets go with the path they were escaping - a token has no spaces,
  // so keeping them would leave `(<gitwarren://…>)` in the body.
  assert.doesNotMatch(rewritten, /[<>]/)
  assert.match(rewritten, /^!\[login screen\]\(gitwarren:\/\/attachment\/[a-f0-9]{64}\.png\)$/)
})

test('a bare path with raw spaces is left alone - markdown does not see an image', async () => {
  // Not a defect in the rewrite: an unescaped space ends a link destination, so
  // CommonMark produces no image node here and there is nothing to ingest. It
  // is pinned because it is the case agents hit most (macOS screenshot names),
  // and because the tempting "fix" - matching paths with a regex instead of
  // parsing - is exactly what would start ingesting images out of fenced code
  // blocks. The instruction to bracket such paths lives in the tool
  // description; see ATTACHMENT_GUIDANCE in `mcp/server.ts`.
  const path = image('Screen Shot with spaces.png', 8)
  const body = `![login screen](${path})`

  assert.equal(await ingestBodyAttachments(body), body)
})

test('non-local URLs resolve to null', () => {
  assert.equal(localPathFor('https://example.com/a.png'), null)
  assert.equal(localPathFor('data:image/png;base64,iVBORw0KGgo='), null)
  assert.equal(localPathFor('gitwarren://attachment/abc.png'), null)
  assert.equal(localPathFor('docs/relative.png'), null)
})
