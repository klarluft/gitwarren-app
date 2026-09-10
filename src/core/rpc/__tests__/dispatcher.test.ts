/**
 * Contract coverage for the message protocol.
 *
 * These tests drive `dispatch` and `handleRequest` directly against a real
 * repository in a temporary directory - no Electron, no window, no carrier.
 * That is the point of them: M2, M3, M4 and M5 each add a way of getting a
 * request to this dispatcher, and every one of those carriers has to produce
 * exactly the behaviour asserted here. When one of them lands, it should be
 * pointed at this file rather than given tests of its own.
 *
 * The service-level behaviour is covered next door in `core/__tests__`; what is
 * tested here is the contract on top of it - which methods exist, what an error
 * looks like once it has been through a response, that the coarse endpoint
 * agrees with the fine ones it replaces, and that a comment arriving this way
 * is attributed to the person at the keyboard.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../../shared/errors.js'
import type { RpcMethod } from '../../../shared/rpc.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-rpc-data-'))
// Realpathed because a repository is stored under its resolved root, and on
// macOS the temporary directory is reached through a symlink.
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'gitwarren-rpc-work-')))
process.env.GITWARREN_DATA_DIR = dataDir

const { dispatch, handleRequest, isRpcMethod, rpcMethodNames } = await import('../dispatcher.js')
const { READ_METHODS } = await import('../../../shared/rpc.js')
const { getDatabase, closeDatabase } = await import('../../db/client.js')
const { comments, commentThreads, repositories, reviewedFiles, reviews } = await import(
  '../../db/schema.js'
)
const { AppError } = await import('../../../shared/errors.js')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
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

let checkout: string
let repositoryId: number
let reviewId: number

before(() => {
  checkout = join(workDir, 'project')
  mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-b', 'main')
  git(checkout, 'config', 'user.email', 'test@example.com')
  git(checkout, 'config', 'user.name', 'Test')

  writeFileSync(join(checkout, 'a.txt'), 'one\ntwo\nthree\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'initial')

  git(checkout, 'checkout', '-b', 'feature')
  writeFileSync(join(checkout, 'a.txt'), 'one\nTWO\nthree\n')
  writeFileSync(join(checkout, 'b.txt'), 'added on the branch\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'feature work')
})

beforeEach(async () => {
  const database = getDatabase()
  database.delete(comments).run()
  database.delete(commentThreads).run()
  database.delete(reviewedFiles).run()
  database.delete(reviews).run()
  database.delete(repositories).run()

  repositoryId = (await dispatch('repositories.add', { path: checkout })).id
  reviewId = (
    await dispatch('reviews.create', { repositoryId, baseRef: 'main', headRef: 'feature' })
  ).id
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

test('a method that is not in the map is refused by name', async () => {
  assert.equal(isRpcMethod('reviews.open'), true)
  assert.equal(isRpcMethod('reviews.summon'), false)

  const error = await expectError('INVALID_INPUT', () =>
    dispatch('reviews.summon' as RpcMethod, undefined)
  )
  // The message names the method, because in M4 this is how a host older than
  // the GUI talking to it reports the mismatch, and a log has to be enough.
  assert.match(error.message, /reviews\.summon/)
})

test('every read method is a method', () => {
  // A typo in READ_METHODS is otherwise silent: the entry would simply never
  // match, and request coalescing would quietly stop applying to that method.
  for (const method of READ_METHODS) {
    assert.ok(rpcMethodNames.includes(method), `${method} is in READ_METHODS but not in the map`)
  }
})

test('no write method claims to be a read', () => {
  // The dangerous direction. A write listed as a read would let a carrier fold
  // two of them into one, and one of the two comments would never be written.
  for (const method of ['comments.createThread', 'comments.reply', 'reviews.create'] as const) {
    assert.equal(READ_METHODS.has(method), false)
  }
})

test('reviews.open answers with the review, its threads and its marks', async () => {
  await dispatch('comments.createThread', { reviewId, body: 'A review-level remark.' })
  await dispatch('reviews.setFileReviewed', {
    reviewId,
    filePath: 'b.txt',
    contentDigest: 'abc123'
  })

  const opened = await dispatch('reviews.open', { id: reviewId })

  assert.equal(opened.review.id, reviewId)
  assert.equal(opened.review.repository.path, checkout)
  assert.equal(opened.threads.length, 1)
  assert.equal(opened.reviewedFiles.length, 1)
  assert.equal(opened.reviewedFiles[0]?.filePath, 'b.txt')
})

test('reviews.open agrees with the three calls it replaces', async () => {
  await dispatch('comments.createThread', { reviewId, body: 'Something worth saying.' })
  await dispatch('reviews.setFileReviewed', { reviewId, filePath: 'a.txt', contentDigest: 'd' })

  const opened = await dispatch('reviews.open', { id: reviewId })
  const [review, threads, marks] = await Promise.all([
    dispatch('reviews.get', { id: reviewId }),
    dispatch('comments.list', { reviewId }),
    dispatch('reviews.reviewedFiles', { reviewId })
  ])

  // The whole justification for the coarse endpoint is that it is the same
  // answer in one round trip instead of three. If that ever stops being true,
  // the renderer is showing something the fine methods would not have shown.
  assert.deepEqual(opened.review, review)
  assert.deepEqual(opened.threads, threads)
  assert.deepEqual(opened.reviewedFiles, marks)
})

test('reviews.open on a review that is not there is NOT_FOUND, not an empty review', async () => {
  await expectError('NOT_FOUND', () => dispatch('reviews.open', { id: reviewId + 999 }))
})

test('a comment written through the dispatcher belongs to the person at the keyboard', async () => {
  // The one thing this boundary is responsible for. Agents never come through
  // here - the MCP server calls the service directly with its own author - so
  // anything arriving this way is someone typing into a GitWarren window.
  const thread = await dispatch('comments.createThread', { reviewId, body: 'Mine.' })

  assert.equal(thread.comments[0]?.author.kind, 'human')
  assert.equal(thread.comments[0]?.author.name, 'Human')
})

test('handleRequest returns the answer under the id it was asked with', async () => {
  const response = await handleRequest({ id: 7, method: 'reviews.get', params: { id: reviewId } })

  assert.equal(response.id, 7)
  assert.ok('result' in response)
  assert.equal((response.result as { id: number }).id, reviewId)
})

test('handleRequest turns a failure into a message rather than a throw', async () => {
  // A carrier holding a byte stream has nowhere to put an exception, so this
  // has to come back as a response no matter what went wrong.
  const response = await handleRequest({ id: 8, method: 'reviews.get', params: { id: 999_999 } })

  assert.equal(response.id, 8)
  assert.ok('error' in response)
  assert.equal(response.error.code, 'NOT_FOUND')
})

test('field errors survive the trip, so a form can still put them under an input', async () => {
  const response = await handleRequest({
    id: 9,
    method: 'reviews.create',
    params: { repositoryId, baseRef: 'main', headRef: 'no-such-branch' }
  })

  assert.ok('error' in response)
  assert.equal(response.error.code, 'INVALID_INPUT')
  assert.deepEqual(response.error.fieldErrors?.headRef, [
    'No such branch, tag or commit: no-such-branch'
  ])
})

test('an unknown method comes back as a response too', async () => {
  const response = await handleRequest({ id: 10, method: 'nope.nope' as RpcMethod })

  assert.ok('error' in response)
  assert.equal(response.error.code, 'INVALID_INPUT')
})

test('the git-backed reads answer for a review, named by id and nothing else', async () => {
  const commits = await dispatch('reviews.commits', { id: reviewId })
  assert.equal(commits.commits.length, 1)
  assert.equal(commits.commits[0]?.subject, 'feature work')

  const diff = await dispatch('reviews.diff', { id: reviewId, changes: 'committed' })
  assert.deepEqual(
    diff.files.map((file) => file.path),
    ['a.txt', 'b.txt']
  )

  const content = await dispatch('reviews.file', {
    id: reviewId,
    path: 'a.txt',
    changes: 'committed'
  })
  assert.deepEqual(content.lines, ['one', 'TWO', 'three'])

  // A path is only ever "a file of this review", and the answer is where that
  // file actually is - which is not always under the repository path once the
  // head branch lives in a linked worktree.
  const absolute = await dispatch('reviews.filePath', { id: reviewId, path: 'a.txt' })
  assert.equal(absolute, join(checkout, 'a.txt'))
})

test('repositories answer through the dispatcher as they do through a service', async () => {
  const list = await dispatch('repositories.list', undefined)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.id, repositoryId)

  const one = await dispatch('repositories.get', { id: repositoryId })
  assert.equal(one.path, checkout)

  const refs = await dispatch('repositories.refs', { id: repositoryId })
  assert.ok(refs.refs.some((ref) => ref.name === 'feature'))

  await expectError('DUPLICATE_REPOSITORY', () => dispatch('repositories.add', { path: checkout }))
})

test('a mark set through the dispatcher is a mark reviews.open reports', async () => {
  await dispatch('reviews.setFileReviewed', { reviewId, filePath: 'a.txt', contentDigest: 'v1' })
  assert.equal((await dispatch('reviews.open', { id: reviewId })).reviewedFiles.length, 1)

  await dispatch('reviews.setFileReviewed', { reviewId, filePath: 'a.txt', contentDigest: null })
  assert.deepEqual((await dispatch('reviews.open', { id: reviewId })).reviewedFiles, [])
})

test('an image arrives as bytes and comes back as an attachment', async () => {
  // A 1x1 PNG. The point is the transport: the renderer has no filesystem, so
  // the bytes travel and are turned back into a Buffer at this boundary.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )

  const attachment = await dispatch('attachments.ingest', {
    bytes: [...png],
    originalName: 'dot.png'
  })

  assert.equal(attachment.mimeType, 'image/png')
  assert.equal(attachment.width, 1)
  assert.equal(attachment.height, 1)
})

test('ingesting nothing is refused before a service is troubled with it', async () => {
  await expectError('INVALID_INPUT', () =>
    dispatch('attachments.ingest', undefined as unknown as { bytes: number[] })
  )
})
