/**
 * Integration coverage for review comments.
 *
 * Two things are worth proving here and neither is CRUD.
 *
 * The first is attribution. The app's one substantive claim is that a comment
 * written by a machine always looks like one, and that two agents in the same
 * review are told apart. That holds only because the author is an argument to
 * the service rather than a field in the payload, so the tests below pass
 * different authors to the same call and check what comes back out.
 *
 * The second is anchoring against a moving branch. The review here is opened on
 * a branch that then keeps changing underneath it, which is the normal case for
 * this app rather than an edge case, and the assertions are about a comment
 * still pointing at the right code afterwards.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../shared/errors.js'
import type { CommentAuthor } from '../../shared/actors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-comment-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-comment-work-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { repositoriesService } = await import('../services/repositories.js')
const { reviewsService } = await import('../services/reviews.js')
const { commentsService } = await import('../services/comments.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { commentThreads, comments, repositories, reviews } = await import('../db/schema.js')
const { AppError } = await import('../../shared/errors.js')
const { HUMAN_AUTHOR, authorDisplayName } = await import('../../shared/actors.js')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, path: string, contents: string): void {
  writeFileSync(join(root, path), contents)
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

/** Two agents, as the MCP server would build them from two handshakes. */
const claude: CommentAuthor = {
  kind: 'agent',
  name: 'Claude Code',
  label: null,
  session: 'aaaa1111'
}
const codex: CommentAuthor = { kind: 'agent', name: 'Codex', label: null, session: 'bbbb2222' }

let checkout: string
let repositoryId: number
let reviewId: number

before(() => {
  checkout = join(workDir, 'project')
  mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-b', 'main')
  git(checkout, 'config', 'user.email', 'test@example.com')
  git(checkout, 'config', 'user.name', 'Test')

  write(checkout, 'app.ts', 'const a = 1\nconst b = 2\n')
  // A file long enough that its first line is nowhere near the change, so the
  // diff's context window genuinely leaves it out. Needed to test a comment on
  // a line the reviewer cannot see - in a three-line file the whole file is
  // context and every line is anchorable.
  write(checkout, 'long.ts', longFile('original'))
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'initial')

  git(checkout, 'checkout', '-b', 'feature')
  write(checkout, 'app.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
  write(checkout, 'long.ts', longFile('edited'))
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'add c')
})

/** 40 numbered lines, with only the last one differing between revisions. */
function longFile(lastLine: string): string {
  const lines = Array.from({ length: 39 }, (_, index) => `line ${index + 1}`)
  return [...lines, lastLine].join('\n') + '\n'
}

beforeEach(async () => {
  getDatabase().delete(comments).run()
  getDatabase().delete(commentThreads).run()
  getDatabase().delete(reviews).run()
  getDatabase().delete(repositories).run()

  const repository = await repositoriesService.add({ path: checkout })
  repositoryId = repository.id
  const review = await reviewsService.create({ repositoryId, baseRef: 'main', headRef: 'feature' })
  reviewId = review.id
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

test('a comment is stamped with the author the surface supplied, not one it asked for', async () => {
  const fromUi = await commentsService.createThread(
    { reviewId, body: 'Looks good to me.' },
    HUMAN_AUTHOR
  )
  const fromAgent = await commentsService.createThread(
    { reviewId, body: 'One concern below.' },
    claude
  )

  assert.equal(fromUi.comments[0]?.author.kind, 'human')
  assert.equal(fromUi.comments[0]?.author.name, 'Human')
  assert.equal(fromAgent.comments[0]?.author.kind, 'agent')
  assert.equal(fromAgent.comments[0]?.author.name, 'Claude Code')
  assert.equal(fromAgent.comments[0]?.author.session, 'aaaa1111')
})

test('an author in the payload is ignored - it is not part of the input schema', async () => {
  // The one thing that must never work: talking your way into a different name
  // by putting it in the body of the call.
  const thread = await commentsService.createThread(
    {
      reviewId,
      body: 'Trust me.',
      author: { kind: 'human', name: 'Human' },
      authorKind: 'human',
      authorName: 'Human'
    },
    claude
  )

  assert.equal(thread.comments[0]?.author.kind, 'agent')
  assert.equal(thread.comments[0]?.author.name, 'Claude Code')
})

test('two agents in one thread stay distinguishable', async () => {
  const thread = await commentsService.createThread(
    { reviewId, body: 'This allocation looks hot.' },
    claude
  )
  await commentsService.reply({ threadId: thread.id, body: 'Agreed, and it is O(n^2).' }, codex)
  await commentsService.reply({ threadId: thread.id, body: 'Fixing it now.' }, HUMAN_AUTHOR)

  const [loaded] = await commentsService.list({ reviewId })
  const names = loaded?.comments.map((comment) => authorDisplayName(comment.author))

  assert.deepEqual(names, ['Claude Code (AI)', 'Codex (AI)', 'Human'])
})

test('a session label distinguishes two runs of the same tool', async () => {
  const refactor: CommentAuthor = { ...claude, label: 'auth-refactor', session: 'cccc3333' }
  const perf: CommentAuthor = { ...claude, label: 'perf-pass', session: 'dddd4444' }

  const thread = await commentsService.createThread({ reviewId, body: 'Renaming this.' }, refactor)
  await commentsService.reply({ threadId: thread.id, body: 'It is also slow.' }, perf)

  const [loaded] = await commentsService.list({ reviewId })
  const names = loaded?.comments.map((comment) => authorDisplayName(comment.author))

  assert.deepEqual(names, ['Claude Code · auth-refactor (AI)', 'Claude Code · perf-pass (AI)'])
})

test('an agent cannot edit or delete what another agent or a human wrote', async () => {
  const human = await commentsService.createThread({ reviewId, body: 'Mine.' }, HUMAN_AUTHOR)
  const other = await commentsService.createThread({ reviewId, body: 'Theirs.' }, codex)

  const humanId = human.comments[0]?.id as number
  const otherId = other.comments[0]?.id as number

  await expectError('FORBIDDEN', () =>
    commentsService.update({ id: humanId, body: 'rewritten' }, claude)
  )
  await expectError('FORBIDDEN', () => commentsService.remove({ id: otherId }, claude))
})

test('an agent can correct its own comment, and the person can edit anything', async () => {
  const mine = await commentsService.createThread({ reviewId, body: 'Typo here.' }, claude)
  const mineId = mine.comments[0]?.id as number

  const corrected = await commentsService.update({ id: mineId, body: 'Typo on the line above.' }, {
    ...claude,
    session: 'a-later-session'
  })
  assert.equal(corrected.body, 'Typo on the line above.')
  // Editing never transfers ownership, even across sessions of the same tool.
  assert.equal(corrected.author.name, 'Claude Code')

  const byHuman = await commentsService.update({ id: mineId, body: 'Actually fine.' }, HUMAN_AUTHOR)
  assert.equal(byHuman.body, 'Actually fine.')
  assert.equal(byHuman.author.kind, 'agent')
})

/* -------------------------------------------------------------------------- */
/* Threads                                                                    */
/* -------------------------------------------------------------------------- */

test('deleting the last comment takes the empty thread with it', async () => {
  const thread = await commentsService.createThread({ reviewId, body: 'Only message.' }, HUMAN_AUTHOR)
  const first = thread.comments[0]?.id as number

  const removed = await commentsService.remove({ id: first }, HUMAN_AUTHOR)
  assert.equal(removed.threadRemoved, true)
  assert.deepEqual(await commentsService.list({ reviewId }), [])
})

test('deleting one of several comments leaves the thread standing', async () => {
  const thread = await commentsService.createThread({ reviewId, body: 'First.' }, HUMAN_AUTHOR)
  const reply = await commentsService.reply({ threadId: thread.id, body: 'Second.' }, claude)

  const removed = await commentsService.remove({ id: reply.id }, claude)
  assert.equal(removed.threadRemoved, false)

  const [loaded] = await commentsService.list({ reviewId })
  assert.equal(loaded?.comments.length, 1)
})

test('resolving records who did it, and reopening clears it', async () => {
  const thread = await commentsService.createThread({ reviewId, body: 'Nit.' }, claude)

  const resolved = await commentsService.setResolved({ threadId: thread.id, resolved: true }, claude)
  assert.equal(resolved.resolvedBy, 'Claude Code (AI)')
  assert.ok(resolved.resolvedAt)

  const reopened = await commentsService.setResolved(
    { threadId: thread.id, resolved: false },
    HUMAN_AUTHOR
  )
  assert.equal(reopened.resolvedAt, null)
  assert.equal(reopened.resolvedBy, null)
  // Reopening argues with the resolution; it does not erase the discussion.
  assert.equal(reopened.comments.length, 1)
})

test('an empty comment is rejected before it reaches the database', async () => {
  const error = await expectError('INVALID_INPUT', () =>
    commentsService.createThread({ reviewId, body: '   ' }, HUMAN_AUTHOR)
  )
  assert.ok(error.fieldErrors?.body)
})

test('a line comment needs both a file and a line', async () => {
  await expectError('INVALID_INPUT', () =>
    commentsService.createThread({ reviewId, body: 'Where?', filePath: 'app.ts' }, HUMAN_AUTHOR)
  )
})

test('deleting a review takes its whole discussion with it', async () => {
  await commentsService.createThread({ reviewId, body: 'Something.' }, HUMAN_AUTHOR)
  await reviewsService.remove({ id: reviewId })

  assert.equal(getDatabase().select().from(commentThreads).all().length, 0)
  assert.equal(getDatabase().select().from(comments).all().length, 0)
})

/* -------------------------------------------------------------------------- */
/* Anchoring against a branch that keeps moving                               */
/* -------------------------------------------------------------------------- */

test('a line comment captures the line it was written against', async () => {
  const thread = await commentsService.createThread(
    { reviewId, body: 'Why 3?', filePath: 'app.ts', line: 3 },
    claude
  )

  assert.equal(thread.filePath, 'app.ts')
  assert.equal(thread.side, 'head')
  assert.equal(thread.line, 3)
  assert.equal(thread.anchorText, 'const c = 3')
  assert.ok(thread.anchorSha)

  const [anchored] = await commentsService.listAnchored({ reviewId })
  assert.deepEqual(anchored?.anchor, { state: 'anchored', line: 3 })
})

test('a comment follows its line when the branch grows above it', async () => {
  const thread = await commentsService.createThread(
    { reviewId, body: 'Why 3?', filePath: 'app.ts', line: 3 },
    claude
  )
  assert.equal(thread.line, 3)

  // The branch moves on: a line is inserted above the one under discussion, so
  // `const c = 3` is now line 4. Nothing re-points the comment; it is re-found.
  write(checkout, 'app.ts', 'const a = 1\nconst b = 2\nconst inserted = 0\nconst c = 3\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'insert above')

  const [anchored] = await commentsService.listAnchored({ reviewId })
  assert.deepEqual(anchored?.anchor, { state: 'moved', line: 4 })

  git(checkout, 'reset', '--hard', 'HEAD~1')
})

test('a comment on rewritten code is reported as outdated rather than moved', async () => {
  await commentsService.createThread(
    { reviewId, body: 'Why 3?', filePath: 'app.ts', line: 3 },
    claude
  )

  write(checkout, 'app.ts', 'const a = 1\nconst b = 2\nconst c = 99\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'change c')

  const [anchored] = await commentsService.listAnchored({ reviewId })
  assert.deepEqual(anchored?.anchor, { state: 'outdated', line: null })

  git(checkout, 'reset', '--hard', 'HEAD~1')
})

test('a line comment keeps a snapshot of the code it was written against', async () => {
  const thread = await commentsService.createThread(
    { reviewId, body: 'Why 3?', filePath: 'app.ts', line: 3 },
    claude
  )

  // The commented line, with what led up to it - GitHub's `diff_hunk`.
  assert.deepEqual(
    thread.anchorSnapshot?.lines.map((line) => line.content),
    ['const a = 1', 'const b = 2', 'const c = 3']
  )
  assert.equal(thread.anchorSnapshot?.clipped, false)
})

test('the snapshot survives the code being rewritten under it', async () => {
  await commentsService.createThread({ reviewId, body: 'Why 3?', filePath: 'app.ts', line: 3 }, claude)

  write(checkout, 'app.ts', 'const a = 1\nconst b = 2\nconst c = 99\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'change c')

  const [anchored] = await commentsService.listAnchored({ reviewId })

  // The anchor is gone, so there is nowhere in the current diff to draw this
  // comment. Without the snapshot the discussion would be stranded next to
  // nothing; with it, a reader can still see what was being objected to.
  assert.deepEqual(anchored?.anchor, { state: 'outdated', line: null })
  assert.deepEqual(
    anchored?.anchorSnapshot?.lines.map((line) => line.content),
    ['const a = 1', 'const b = 2', 'const c = 3']
  )

  git(checkout, 'reset', '--hard', 'HEAD~1')
})

test('the snapshot is never rewritten by later activity on the thread', async () => {
  const thread = await commentsService.createThread(
    { reviewId, body: 'Why 3?', filePath: 'app.ts', line: 3 },
    claude
  )

  write(checkout, 'app.ts', 'const a = 1\nconst b = 2\nconst c = 99\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'change c')

  await commentsService.reply({ threadId: thread.id, body: 'Still wondering.' }, HUMAN_AUTHOR)
  await commentsService.setResolved({ threadId: thread.id, resolved: true }, HUMAN_AUTHOR)

  const [reloaded] = await commentsService.list({ reviewId })
  assert.deepEqual(
    reloaded?.anchorSnapshot?.lines.map((line) => line.content),
    ['const a = 1', 'const b = 2', 'const c = 3']
  )

  git(checkout, 'reset', '--hard', 'HEAD~1')
})

test('commenting on a line outside the diff is kept, and says so', async () => {
  // Line 1 of `long.ts` is far above the only hunk, so the reviewer never sees
  // it in this diff. An agent reading the file with git can still have
  // something to say about it, and dropping the comment would be worse than
  // showing it out of line - so it is stored with no anchor text and reported
  // as unpinnable.
  const thread = await commentsService.createThread(
    { reviewId, body: 'Unrelated but worth noting.', filePath: 'long.ts', line: 1 },
    claude
  )

  assert.equal(thread.anchorText, null)
  // Nothing was on screen to snapshot either; the comment stands on its own.
  assert.equal(thread.anchorSnapshot, null)

  const [anchored] = await commentsService.listAnchored({ reviewId })
  assert.deepEqual(anchored?.anchor, { state: 'outdated', line: null })
})

test('a context line inside the diff is anchorable, not just a changed one', async () => {
  // The lines git prints around a change are part of what the reviewer is
  // looking at, so they can be commented on like any other.
  const thread = await commentsService.createThread(
    { reviewId, body: 'This one is fine.', filePath: 'app.ts', line: 1 },
    claude
  )

  assert.equal(thread.anchorText, 'const a = 1')

  const [anchored] = await commentsService.listAnchored({ reviewId })
  assert.deepEqual(anchored?.anchor, { state: 'anchored', line: 1 })
})

test('review-level threads have no anchor to resolve', async () => {
  await commentsService.createThread({ reviewId, body: 'Overall: ship it.' }, HUMAN_AUTHOR)

  const [anchored] = await commentsService.listAnchored({ reviewId })
  assert.equal(anchored?.anchor, null)
})

test('counts report open discussions separately from total', async () => {
  const first = await commentsService.createThread({ reviewId, body: 'One.' }, claude)
  await commentsService.createThread({ reviewId, body: 'Two.' }, claude)
  await commentsService.setResolved({ threadId: first.id, resolved: true }, HUMAN_AUTHOR)

  assert.deepEqual(await commentsService.counts(reviewId), { threads: 2, unresolved: 1 })
})

/* -------------------------------------------------------------------------- */
/* Attachments                                                                */
/* -------------------------------------------------------------------------- */

/** A tiny but real PNG, 10x10, so the header parses. */
function pngBytes(filler = 0): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(10, 8)
  ihdr.writeUInt32BE(10, 12)
  return Buffer.concat([header, ihdr, Buffer.from([filler])])
}

function writeImage(name: string, filler = 0): string {
  const path = join(workDir, name)
  writeFileSync(path, pngBytes(filler))
  return path
}

test('a body naming a local image comes back with a token and a resolved attachment', async () => {
  // The agent write path end to end: an agent writes a screenshot to disk and
  // references it, and what is stored is a token pointing at the app's own copy
  // - so the comment still renders after the original file is gone.
  const path = writeImage('agent-screenshot.png', 1)

  const thread = await commentsService.createThread(
    { reviewId, body: `The dropdown renders behind the modal:\n\n![dropdown behind modal](${path})` },
    claude
  )

  const comment = thread.comments[0]
  assert.ok(comment)
  assert.match(comment.body, /gitwarren:\/\/attachment\/[a-f0-9]{64}\.png/)
  assert.doesNotMatch(comment.body, /agent-screenshot\.png/)

  assert.equal(comment.attachments.length, 1)
  const [attachment] = comment.attachments
  assert.ok(attachment)
  // The alt text is what an agent without vision has to go on.
  assert.equal(attachment.alt, 'dropdown behind modal')
  assert.equal(attachment.mimeType, 'image/png')
  assert.deepEqual([attachment.width, attachment.height], [10, 10])
  assert.ok(comment.body.includes(attachment.url))
  // `path` is the whole reason there is no `get_attachment` tool: an agent
  // reads the file with the tools it already has.
  assert.ok(existsSync(attachment.path))
})

test('the resolved attachments survive a re-read', async () => {
  const path = writeImage('persisted.png', 2)
  await commentsService.createThread({ reviewId, body: `![a bug](${path})` }, claude)

  const [thread] = await commentsService.list({ reviewId })
  const attachment = thread?.comments[0]?.attachments[0]

  assert.ok(attachment)
  assert.equal(attachment.alt, 'a bug')
  assert.ok(existsSync(attachment.path))
})

test('a reply and an edit ingest their images too', async () => {
  const thread = await commentsService.createThread({ reviewId, body: 'Opening.' }, HUMAN_AUTHOR)

  const reply = await commentsService.reply(
    { threadId: thread.id, body: `Here it is: ![reply shot](${writeImage('reply.png', 3)})` },
    claude
  )
  assert.equal(reply.attachments.length, 1)
  assert.match(reply.body, /gitwarren:\/\/attachment\//)

  const edited = await commentsService.update(
    { id: reply.id, body: `Corrected: ![edited shot](${writeImage('edited.png', 4)})` },
    claude
  )
  assert.equal(edited.attachments.length, 1)
  assert.equal(edited.attachments[0]?.alt, 'edited shot')
})

test('a comment with no images carries an empty attachments array, not undefined', async () => {
  const thread = await commentsService.createThread({ reviewId, body: 'Just prose.' }, claude)

  assert.deepEqual(thread.comments[0]?.attachments, [])
})

test('an unresolvable path leaves the body as written and still saves the comment', async () => {
  // Failing the call would throw away a body an agent spent real tokens on,
  // over a detail it cannot see or usefully retry.
  const missing = join(workDir, 'this-was-never-written.png')

  const thread = await commentsService.createThread(
    { reviewId, body: `I meant to attach this: ![missing](${missing})` },
    claude
  )

  assert.equal(thread.comments[0]?.body, `I meant to attach this: ![missing](${missing})`)
  assert.deepEqual(thread.comments[0]?.attachments, [])
})

test('an image in a fenced code block is neither ingested nor listed', async () => {
  const path = writeImage('documented.png', 5)
  const body = ['How to attach:', '', '```', `![alt](${path})`, '```'].join('\n')

  const thread = await commentsService.createThread({ reviewId, body }, claude)

  assert.equal(thread.comments[0]?.body, body)
  assert.deepEqual(thread.comments[0]?.attachments, [])
})
