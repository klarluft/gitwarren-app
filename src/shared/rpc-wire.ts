/**
 * One request, as text on the wire.
 *
 * Apart from the socket so it can be tested, for the same reason
 * `loopback-fragment.ts` is: what it gets wrong, it gets wrong silently.
 *
 * The reason this is not `JSON.stringify` is bytes. `attachments.ingest` is
 * handed an `ArrayBuffer` by the composer - which is what the Electron carrier
 * wants, because structured clone carries it perfectly - and it is also the one
 * thing `JSON.stringify` destroys without complaining, turning it into `{}`.
 * The image then arrives at the dispatcher as an empty object and fails the
 * format sniff, which reaches the user as "that file is not a PNG, JPEG, GIF or
 * WebP image" about a file that certainly was one.
 *
 * base64 is what the dispatcher already documents for a carrier over a byte
 * stream - see `toIngestSource` in `core/rpc/dispatcher.ts`, which accepts it
 * alongside an array of byte values and an `ArrayBuffer` - so this is a choice
 * among the encodings that end is known to take, not a new one.
 *
 * ## Why this is in `shared/` and not next to a carrier
 *
 * It was `web/wire.ts` until M4.4, when the second carrier over a byte stream
 * arrived: `core/rpc/stdio-client.ts` was still writing `JSON.stringify`, so an
 * image attached to a review on another machine crossed the `ssh` pipe as `{}`
 * and was refused on the far side for not being an image. That is the same
 * argument `core/rpc/ndjson.ts` makes about framing, one layer up: two answers
 * to "how does a request become bytes" is a disagreement nobody can see, and
 * the failure it produces names the wrong thing. So there is one encoder, and
 * the WebSocket carrier and the stdio client are both users of it.
 *
 * `shared/` is where it can be: one of those two readers is compiled into a
 * browser bundle and the other runs in Node, and this file has to be importable
 * by both.
 *
 * Plain JS and no DOM: `btoa` is the one global it needs, and it is a global in
 * Node too.
 */
import type { RpcRequest } from './rpc.js'

/**
 * `btoa` wants a string of char codes, and a call stack to build it with.
 *
 * A screenshot is a few megabytes, and spreading that many arguments into
 * `String.fromCharCode` overflows the stack - so the bytes go in slices. This
 * is the difference between pasting an image working and the tab throwing
 * `RangeError: Maximum call stack size exceeded` on the one path where the
 * payload is large by definition.
 */
const CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/**
 * Encode a request for the socket, base64-ing any bytes in its params.
 *
 * The scan is one level deep on purpose. Params are flat objects, the protocol
 * has exactly one field that ever holds bytes, and a recursive walk would be a
 * general serialiser - a thing with its own edge cases to maintain, in the
 * carrier, which is the layer least allowed to have any.
 */
export function frame(request: RpcRequest): string {
  const { params } = request
  if (typeof params !== 'object' || params === null) return JSON.stringify(request)

  let encoded: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(params)) {
    const bytes = asBytes(value)
    if (bytes === null) continue
    encoded ??= { ...params }
    encoded[key] = toBase64(bytes)
  }

  return JSON.stringify(encoded === null ? request : { ...request, params: encoded })
}

/**
 * A value's bytes, when it is bytes.
 *
 * A typed array is taken over its own range rather than over the whole buffer
 * behind it - a `Uint8Array` that is a view of part of a larger allocation is
 * ordinary, and sending the rest of that allocation would be sending memory
 * nobody asked for.
 */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}
