/**
 * What the client does when the far end misbehaves.
 *
 * The happy path is not here. `dispatcher.test.ts` runs the entire protocol
 * contract through this client against the real `serveStdio`, which is a far
 * better test of "does it work" than anything in this file - and leaves this
 * one free to be only about the cases a working daemon never produces.
 *
 * Those cases are the reason M4 is harder than M1. A function call cannot
 * half-answer, and Electron IPC cannot lose a reply; a pipe to another machine
 * does both, and every one of these behaviours is something a screen will
 * eventually be showing a person.
 *
 * The far end here is a `PassThrough` a test writes to by hand, because that is
 * the only way to produce a daemon that answers out of order, replies twice,
 * emits a login banner, or dies mid-request. A real one, correctly, will not.
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { createStdioClient } from '../stdio-client.js'
import { AppError } from '../../../shared/errors.js'
import type { RpcRequest } from '../../../shared/rpc.js'

/**
 * A client wired to two streams a test controls.
 *
 * `sent` collects the frames the client wrote, already parsed, so an assertion
 * can be about the request rather than about a string.
 */
function harness(): {
  client: ReturnType<typeof createStdioClient>
  sent: RpcRequest[]
  reply: (line: string) => void
  endStream: () => void
  closes: AppError[]
} {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const sent: RpcRequest[] = []
  const closes: AppError[] = []

  toHost.setEncoding('utf8')
  toHost.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) sent.push(JSON.parse(line) as RpcRequest)
    }
  })

  const client = createStdioClient({
    input: fromHost,
    output: toHost,
    onClose: (error) => closes.push(error)
  })

  return {
    client,
    sent,
    reply: (line: string) => fromHost.write(`${line}\n`),
    endStream: () => fromHost.end(),
    closes
  }
}

/** Let the stream's 'data' event run before asserting on what it produced. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('answers are matched by id, not by the order they arrive in', async () => {
  const { client, sent, reply } = harness()

  const first = client.request('repositories.list')
  const second = client.request('reviews.list', {})
  await settle()

  assert.equal(sent.length, 2)
  const [a, b] = sent as [RpcRequest, RpcRequest]
  assert.notEqual(a.id, b.id)

  // Backwards, which is exactly what the daemon does when the second question
  // is cheaper than the first - and what a FIFO client would deadlock on.
  reply(JSON.stringify({ id: b.id, result: ['second'] }))
  reply(JSON.stringify({ id: a.id, result: ['first'] }))

  assert.deepEqual(await first, ['first'])
  assert.deepEqual(await second, ['second'])
})

test('an error from the far end arrives as the AppError it was raised as', async () => {
  const { client, sent, reply } = harness()

  const pending = client.request('reviews.get', { id: 4 })
  await settle()

  reply(
    JSON.stringify({
      id: sent[0]?.id,
      error: {
        code: 'INVALID_INPUT',
        message: 'No such branch.',
        fieldErrors: { headRef: ['No such branch, tag or commit: nope'] }
      }
    })
  )

  const error = await pending.then(
    () => null,
    (thrown: unknown) => thrown as AppError
  )

  // Code, message and field errors all the way across, so a form on this side
  // can still put the message under the right input.
  assert.ok(error instanceof AppError)
  assert.equal(error.code, 'INVALID_INPUT')
  assert.deepEqual(error.fieldErrors?.headRef, ['No such branch, tag or commit: nope'])
})

test('a request in flight when the connection dies fails as HOST_OFFLINE', async () => {
  const { client, endStream, closes } = harness()

  const pending = client.request('repositories.list')
  await settle()
  endStream()

  const error = await pending.then(
    () => null,
    (thrown: unknown) => thrown as AppError
  )

  assert.ok(error instanceof AppError)
  assert.equal(error.code, 'HOST_OFFLINE')
  // Reported once, and to the owner, so a pool can decide about reconnecting.
  assert.equal(closes.length, 1)
  assert.equal(closes[0]?.code, 'HOST_OFFLINE')
})

test('a lost request is not resent when the connection returns', async () => {
  // The decision this whole file exists to protect: a write that died in flight
  // may or may not have been applied, and re-sending `comments.reply` after an
  // answer nobody saw is a second comment on someone's review.
  const { client, sent, endStream } = harness()

  const pending = client.request('comments.reply', { threadId: 1, body: 'Once.' })
  await settle()
  assert.equal(sent.length, 1)

  endStream()
  await pending.catch(() => undefined)
  await settle()

  assert.equal(sent.length, 1, 'the request was sent exactly once')
  assert.equal(client.isOpen(), false, 'and the client does not quietly carry on')
})

test('a request made after the connection died fails immediately', async () => {
  const { client, endStream } = harness()
  endStream()
  await settle()

  const error = await client.request('repositories.list').then(
    () => null,
    (thrown: unknown) => thrown as AppError
  )

  assert.ok(error instanceof AppError)
  assert.equal(error.code, 'HOST_OFFLINE')
})

test('a login banner on stdout is reported as what it is', async () => {
  // The single most likely misconfiguration of a real host: a `.bashrc` that
  // echoes something on a non-interactive login. The stream is now unusable and
  // the message has to send someone to their shell profile, not to a bug
  // report.
  const { client, reply } = harness()

  const pending = client.request('repositories.list')
  await settle()
  reply('Welcome to Ubuntu 24.04 LTS')

  const error = await pending.then(
    () => null,
    (thrown: unknown) => thrown as AppError
  )

  assert.ok(error instanceof AppError)
  assert.equal(error.code, 'HOST_OFFLINE')
  assert.match(error.message, /login script/i)
})

test('an answer to a question nobody asked is ignored rather than fatal', async () => {
  const { client, sent, reply } = harness()

  const pending = client.request('repositories.list')
  await settle()

  // A duplicate, or a very late reply. Neither is worth tearing down a
  // connection that is otherwise working.
  reply(JSON.stringify({ id: 9999, result: ['nobody asked'] }))
  reply(JSON.stringify({ id: sent[0]?.id, result: ['the real answer'] }))

  assert.deepEqual(await pending, ['the real answer'])
  assert.equal(client.isOpen(), true)
})

test('blank lines between frames are not an error', async () => {
  // `ssh` is happy to put a stray newline on the stream around a banner.
  const { client, sent, reply } = harness()

  const pending = client.request('repositories.list')
  await settle()

  reply('')
  reply(JSON.stringify({ id: sent[0]?.id, result: [] }))

  assert.deepEqual(await pending, [])
})

test('close rejects what is in flight and says so once', async () => {
  const { client, closes } = harness()

  const pending = client.request('repositories.list')
  await settle()

  client.close('Told to stop.')
  client.close('Told again.')

  const error = await pending.then(
    () => null,
    (thrown: unknown) => thrown as AppError
  )

  assert.equal(error?.code, 'HOST_OFFLINE')
  assert.equal(error?.message, 'Told to stop.')
  assert.equal(closes.length, 1, 'closing twice is not two events')
})
