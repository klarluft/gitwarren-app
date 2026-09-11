/**
 * Coverage for the encoding that makes pasting a screenshot work at all - in a
 * browser tab, and since M4.4 onto a review on another machine.
 *
 * `JSON.stringify` turns an `ArrayBuffer` into `{}` and says nothing about it.
 * The image then reaches the dispatcher as an empty object, fails the format
 * sniff, and the user is told their PNG is not a PNG - a failure that reads as
 * being about the file rather than about the wire, which is the kind that costs
 * an afternoon. So the first test asserts the bytes survive, and the last one
 * asserts the size at which the naive implementation of base64 stops working.
 *
 * The decode side is the dispatcher's `toIngestSource`, which has taken base64
 * since M2 for the stdio carrier. Nothing new is being agreed here; this is the
 * asking ends learning to speak what the daemon already listened for.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frame } from '../rpc-wire.js'
import type { RpcRequest } from '../rpc.js'

/** What the dispatcher does with what arrives, in one line. */
function bytesOf(text: string): Buffer {
  const { params } = JSON.parse(text) as { params: { bytes: string } }
  return Buffer.from(params.bytes, 'base64')
}

test('an ArrayBuffer of image bytes arrives as base64, not as an empty object', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const request: RpcRequest = {
    id: 1,
    method: 'attachments.ingest',
    params: { bytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }
  }

  const text = frame(request)

  assert.ok(!text.includes('"bytes":{}'), 'the bytes were stringified away')
  assert.deepEqual(bytesOf(text), png)
})

test('a typed array is sent over its own range and not the buffer behind it', () => {
  // A view of part of a larger allocation is ordinary, and sending the rest of
  // that allocation would be sending memory nobody asked for.
  const backing = new Uint8Array([0, 0, 1, 2, 3, 0, 0])
  const view = backing.subarray(2, 5)

  const text = frame({ id: 2, method: 'attachments.ingest', params: { bytes: view } })

  assert.deepEqual(bytesOf(text), Buffer.from([1, 2, 3]))
})

test('everything alongside the bytes is carried through untouched', () => {
  const text = frame({
    id: 3,
    method: 'attachments.ingest',
    params: { bytes: new Uint8Array([1]), originalName: 'Screenshot 2026-09-10 at 14.02.png' }
  })

  const decoded = JSON.parse(text) as RpcRequest & { params: { originalName: string } }
  assert.equal(decoded.id, 3)
  assert.equal(decoded.method, 'attachments.ingest')
  assert.equal(decoded.params.originalName, 'Screenshot 2026-09-10 at 14.02.png')
})

test('a request with no bytes in it is ordinary JSON', () => {
  // Which is nearly every request. The scan must not change what they look like.
  const params = { id: 7, path: 'src/index.ts', changes: 'all' }
  const text = frame({ id: 4, method: 'reviews.file', params })

  assert.equal(text, JSON.stringify({ id: 4, method: 'reviews.file', params }))
})

test('params that are undefined survive being framed', () => {
  // `repositories.list` takes none, and the carrier sends the request anyway.
  assert.equal(
    frame({ id: 5, method: 'repositories.list', params: undefined }),
    JSON.stringify({ id: 5, method: 'repositories.list', params: undefined })
  )
})

test('an image large enough to overflow a call stack still encodes', () => {
  // The reason the encoder works in slices. Four megabytes is an ordinary
  // retina screenshot and about a hundred times the argument limit that
  // `String.fromCharCode(...bytes)` dies at.
  const big = new Uint8Array(4 * 1024 * 1024)
  for (let index = 0; index < big.length; index += 1) big[index] = index % 256

  const text = frame({ id: 6, method: 'attachments.ingest', params: { bytes: big } })

  assert.deepEqual(bytesOf(text), Buffer.from(big))
})
