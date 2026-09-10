/**
 * Contract coverage for the message protocol, run once per carrier.
 *
 * These tests drive the dispatcher against a real repository in a temporary
 * directory - no Electron, no window. That is the point of them: M2, M3, M4 and
 * M5 each add a way of getting a request to this dispatcher, and every one of
 * those carriers has to produce exactly the behaviour asserted here. When one
 * lands, it is pointed at this file rather than given tests of its own.
 *
 * M2 is the first time that promise is cashed. The whole file now runs twice:
 * once through `dispatch` and `handleRequest` as a function call, and once
 * through the newline-delimited JSON carrier in `rpc/stdio.ts` - the same code
 * `out/daemon/gitwarren.cjs` runs, over a stream, with every message serialised and
 * parsed. A carrier that passes here is a carrier that cannot have its own
 * opinion about what a review is, which is the property the arrangement exists
 * to hold.
 *
 * The stream is a pair of `PassThrough`s rather than a spawned process on
 * purpose: what a second process would add over this is the OS pipe, and spike
 * S2 already put 50 MB of exactly these frames through the worst pipe in the
 * plan - `wsl.exe` - byte-exact. What is worth testing here is the framing and
 * the serialisation, and both of those are in this process.
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
import { PassThrough } from 'node:stream'
import { after, before, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../../shared/errors.js'
import type {
  RpcMethod,
  RpcParams,
  RpcRequest,
  RpcResponse,
  RpcResult
} from '../../../shared/rpc.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-rpc-data-'))
// Realpathed because a repository is stored under its resolved root, and on
// macOS the temporary directory is reached through a symlink.
const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'gitwarren-rpc-work-')))
process.env.GITWARREN_DATA_DIR = dataDir

const { dispatch, handleRequest, isRpcMethod, rpcMethodNames } = await import('../dispatcher.js')
const { serveStdio } = await import('../stdio.js')
const { READ_METHODS, resultOf } = await import('../../../shared/rpc.js')
const { getDatabase, closeDatabase } = await import('../../db/client.js')
const { comments, commentThreads, repositories, reviewedFiles, reviews } = await import(
  '../../db/schema.js'
)
const { AppError } = await import('../../../shared/errors.js')

/**
 * A way of asking. `call` throws an `AppError` the way a caller expects; `send`
 * is the raw message door, for the tests that are about responses themselves.
 */
interface Carrier {
  name: string
  call<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
  send(request: RpcRequest): Promise<RpcResponse>
}

const inProcess: Carrier = {
  name: 'in process',
  call: dispatch,
  send: handleRequest
}

/**
 * The daemon's carrier, wired to itself.
 *
 * One reader, one writer and a map of ids, which is the client half every
 * carrier from here to M6 will have some version of. Responses are matched by
 * id rather than by arrival order, because the daemon answers concurrently and
 * a test that assumed otherwise would be asserting something the protocol does
 * not promise.
 */
function stdioCarrier(): Carrier {
  const toDaemon = new PassThrough()
  const fromDaemon = new PassThrough()

  serveStdio({ input: toDaemon, output: fromDaemon })

  const waiting = new Map<number, (response: RpcResponse) => void>()
  let buffer = ''

  fromDaemon.setEncoding('utf8')
  fromDaemon.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) {
        const response = JSON.parse(line) as RpcResponse
        waiting.get(response.id)?.(response)
        waiting.delete(response.id)
      }
      newline = buffer.indexOf('\n')
    }
  })

  let nextId = 1

  const send = (request: RpcRequest): Promise<RpcResponse> =>
    new Promise((resolve) => {
      waiting.set(request.id, resolve)
      toDaemon.write(`${JSON.stringify(request)}\n`)
    })

  return {
    name: 'over stdio',
    send,
    async call<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
      // `resultOf` is the shared unwrap every carrier uses, so a `NOT_FOUND`
      // from a pipe reaches a caller as the same `AppError` a local call threw.
      return resultOf(
        (await send({ id: nextId++, method, params })) as RpcResponse<RpcResult<M>>
      )
    }
  }
}

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

/** A 1x1 PNG, the smallest thing that is really an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

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

/**
 * Every assertion below, once per carrier.
 *
 * The suite is the contract; the carrier is a detail of how the question
 * arrived. If a test can only pass one way round, either the carrier is doing
 * something it should not or the protocol is promising something it cannot
 * deliver over a wire - and both are worth finding here rather than in M4.
 */
function contract(carrier: Carrier): void {
  test(`[${carrier.name}] a method that is not in the map is refused by name`, async () => {
    assert.equal(isRpcMethod('reviews.open'), true)
    assert.equal(isRpcMethod('reviews.summon'), false)

    const error = await expectError('INVALID_INPUT', () =>
      carrier.call('reviews.summon' as RpcMethod, undefined)
    )
    // The message names the method, because in M4 this is how a host older than
    // the GUI talking to it reports the mismatch, and a log has to be enough.
    assert.match(error.message, /reviews\.summon/)
  })

  test(`[${carrier.name}] reviews.open answers with the review, its threads and its marks`, async () => {
    await carrier.call('comments.createThread', { reviewId, body: 'A review-level remark.' })
    await carrier.call('reviews.setFileReviewed', {
      reviewId,
      filePath: 'b.txt',
      contentDigest: 'abc123'
    })

    const opened = await carrier.call('reviews.open', { id: reviewId })

    assert.equal(opened.review.id, reviewId)
    assert.equal(opened.review.repository.path, checkout)
    assert.equal(opened.threads.length, 1)
    assert.equal(opened.reviewedFiles.length, 1)
    assert.equal(opened.reviewedFiles[0]?.filePath, 'b.txt')
  })

  test(`[${carrier.name}] reviews.open agrees with the three calls it replaces`, async () => {
    await carrier.call('comments.createThread', { reviewId, body: 'Something worth saying.' })
    await carrier.call('reviews.setFileReviewed', { reviewId, filePath: 'a.txt', contentDigest: 'd' })

    const opened = await carrier.call('reviews.open', { id: reviewId })
    const [review, threads, marks] = await Promise.all([
      carrier.call('reviews.get', { id: reviewId }),
      carrier.call('comments.list', { reviewId }),
      carrier.call('reviews.reviewedFiles', { reviewId })
    ])

    // The whole justification for the coarse endpoint is that it is the same
    // answer in one round trip instead of three. If that ever stops being true,
    // the renderer is showing something the fine methods would not have shown.
    assert.deepEqual(opened.review, review)
    assert.deepEqual(opened.threads, threads)
    assert.deepEqual(opened.reviewedFiles, marks)
  })

  test(`[${carrier.name}] reviews.open on a review that is not there is NOT_FOUND, not an empty review`, async () => {
    await expectError('NOT_FOUND', () => carrier.call('reviews.open', { id: reviewId + 999 }))
  })

  test(`[${carrier.name}] a comment written through the dispatcher belongs to the person at the keyboard`, async () => {
    // The one thing this boundary is responsible for. Agents never come through
    // here - the MCP server calls the service directly with its own author - so
    // anything arriving this way is someone typing into a GitWarren window.
    const thread = await carrier.call('comments.createThread', { reviewId, body: 'Mine.' })

    assert.equal(thread.comments[0]?.author.kind, 'human')
    assert.equal(thread.comments[0]?.author.name, 'Human')
  })

  test(`[${carrier.name}] handleRequest returns the answer under the id it was asked with`, async () => {
    const response = await carrier.send({ id: 7, method: 'reviews.get', params: { id: reviewId } })

    assert.equal(response.id, 7)
    assert.ok('result' in response)
    assert.equal((response.result as { id: number }).id, reviewId)
  })

  test(`[${carrier.name}] handleRequest turns a failure into a message rather than a throw`, async () => {
    // A carrier holding a byte stream has nowhere to put an exception, so this
    // has to come back as a response no matter what went wrong.
    const response = await carrier.send({ id: 8, method: 'reviews.get', params: { id: 999_999 } })

    assert.equal(response.id, 8)
    assert.ok('error' in response)
    assert.equal(response.error.code, 'NOT_FOUND')
  })

  test(`[${carrier.name}] field errors survive the trip, so a form can still put them under an input`, async () => {
    const response = await carrier.send({
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

  test(`[${carrier.name}] an unknown method comes back as a response too`, async () => {
    const response = await carrier.send({ id: 10, method: 'nope.nope' as RpcMethod })

    assert.ok('error' in response)
    assert.equal(response.error.code, 'INVALID_INPUT')
  })

  test(`[${carrier.name}] the git-backed reads answer for a review, named by id and nothing else`, async () => {
    const commits = await carrier.call('reviews.commits', { id: reviewId })
    assert.equal(commits.commits.length, 1)
    assert.equal(commits.commits[0]?.subject, 'feature work')

    const diff = await carrier.call('reviews.diff', { id: reviewId, changes: 'committed' })
    assert.deepEqual(
      diff.files.map((file) => file.path),
      ['a.txt', 'b.txt']
    )

    const content = await carrier.call('reviews.file', {
      id: reviewId,
      path: 'a.txt',
      changes: 'committed'
    })
    assert.deepEqual(content.lines, ['one', 'TWO', 'three'])

    // A path is only ever "a file of this review", and the answer is where that
    // file actually is - which is not always under the repository path once the
    // head branch lives in a linked worktree.
    const absolute = await carrier.call('reviews.filePath', { id: reviewId, path: 'a.txt' })
    assert.equal(absolute, join(checkout, 'a.txt'))
  })

  test(`[${carrier.name}] repositories answer through the dispatcher as they do through a service`, async () => {
    const list = await carrier.call('repositories.list', undefined)
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, repositoryId)

    const one = await carrier.call('repositories.get', { id: repositoryId })
    assert.equal(one.path, checkout)

    const refs = await carrier.call('repositories.refs', { id: repositoryId })
    assert.ok(refs.refs.some((ref) => ref.name === 'feature'))

    await expectError('DUPLICATE_REPOSITORY', () => carrier.call('repositories.add', { path: checkout }))
  })

  test(`[${carrier.name}] a mark set through the dispatcher is a mark reviews.open reports`, async () => {
    await carrier.call('reviews.setFileReviewed', { reviewId, filePath: 'a.txt', contentDigest: 'v1' })
    assert.equal((await carrier.call('reviews.open', { id: reviewId })).reviewedFiles.length, 1)

    await carrier.call('reviews.setFileReviewed', { reviewId, filePath: 'a.txt', contentDigest: null })
    assert.deepEqual((await carrier.call('reviews.open', { id: reviewId })).reviewedFiles, [])
  })

  test(`[${carrier.name}] an image arrives as bytes and comes back as an attachment`, async () => {
    // The point is the transport: the renderer has no filesystem, so the bytes
    // travel and are turned back into a Buffer at this boundary.
    const attachment = await carrier.call('attachments.ingest', {
      bytes: [...PNG],
      originalName: 'dot.png'
    })

    assert.equal(attachment.mimeType, 'image/png')
    assert.equal(attachment.width, 1)
    assert.equal(attachment.height, 1)
  })

  test(`[${carrier.name}] ingesting nothing is refused before a service is troubled with it`, async () => {
    await expectError('INVALID_INPUT', () =>
      carrier.call('attachments.ingest', undefined)
    )
  })

  test(`[${carrier.name}] an image also arrives as base64, which is what a wire can carry`, async () => {
    // The one thing the protocol needed in order to survive a byte stream. An
    // `ArrayBuffer` is what the renderer sends and what Electron's structured
    // clone preserves; `JSON.stringify` turns it into `{}`, so a carrier over a
    // pipe has to have some other way of saying "these bytes". base64 is it, at
    // 1.33 bytes on the wire per byte of image rather than the four a
    // stringified `number[]` costs.
    const attachment = await carrier.call('attachments.ingest', {
      bytes: PNG.toString('base64'),
      originalName: 'dot.png'
    })

    assert.equal(attachment.mimeType, 'image/png')
    assert.equal(attachment.width, 1)
  })

  test(`[${carrier.name}] bytes in a shape no carrier produces are refused by name`, async () => {
    // What `{}` - a stringified ArrayBuffer - used to do here was reach
    // `Buffer.from` and come back as INTERNAL, which over an ssh pipe is
    // indistinguishable from the daemon being broken.
    const error = await expectError('INVALID_INPUT', () =>
      carrier.call('attachments.ingest', { bytes: {} as unknown as string })
    )
    assert.match(error.message, /base64/)
  })

}

for (const carrier of [inProcess, stdioCarrier()]) contract(carrier)
