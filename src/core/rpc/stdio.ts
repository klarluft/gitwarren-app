/**
 * The protocol on a byte stream: newline-delimited JSON.
 *
 * This is the first carrier that is not a function call. Electron IPC pairs a
 * request with its answer itself and hands both sides real objects; here there
 * are two pipes and no framing at all, so the carrier has to invent one, and
 * everything the protocol assumed for free has to be paid for explicitly.
 *
 * ## Why newline-delimited and not a length prefix
 *
 * `JSON.stringify` never emits a raw newline - U+000A inside a string is always
 * escaped as `\n`, and there is nowhere else it could appear - so a newline is
 * an unambiguous frame boundary for JSON specifically, and costs one byte.
 * Spike S2 pushed 50 MB of exactly this shape through `wsl.exe` byte-exact at
 * 56 MB/s, which is the carrier that had the best claim to mangling it. A
 * length prefix would be marginally cheaper to parse and considerably harder to
 * debug: `cat` on a log of this is readable, and a human can paste one line
 * into a terminal and see what the far side says.
 *
 * The same framing is what M3's WebSocket carrier does not need (frames are the
 * transport's job there) and what M4's `ssh` and M5's `wsl.exe` carriers get to
 * reuse unchanged, because all three are this one with a different child
 * process in front of it.
 *
 * ## What this file is not allowed to do
 *
 * Deliver bytes, and nothing else. It does not know what a method means, it
 * does not validate `params`, and it does not decide who a comment belongs to -
 * see the note at the top of `dispatcher.ts`. Every request goes through
 * `handleRoutedRequest`, which is the same door `main/ipc.ts` uses, so a review
 * opened over a pipe is the review the window would have shown.
 *
 * Its tests are `rpc/__tests__/dispatcher.test.ts`. That is deliberate: a
 * carrier with its own test suite would be asserting its own opinions about the
 * protocol, which is the failure this whole arrangement exists to prevent.
 */
import { handleRoutedRequest } from '../hosts/router.js'
import { MAX_FRAME_BYTES, readFrames } from './ndjson.js'
import { AppError } from '../../shared/errors.js'
import type { RpcRequest, RpcResponse } from '../../shared/rpc.js'

/**
 * The id used when a frame is so malformed there is no id to answer under.
 *
 * Zero rather than null because the field is typed as a number and a peer has
 * to be able to parse the response with the same reader it uses for every other
 * one. No real request uses it: ids are assigned from 1 upwards.
 */
const NO_ID = 0

export interface StdioCarrierOptions {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  /** Called when the input ends, which is how a parent says it is finished. */
  onEnd?: () => void
}

/** Whether a decoded frame is shaped enough like a request to answer at all. */
function asRequest(value: unknown): RpcRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, method } = value as Partial<RpcRequest>
  if (!Number.isInteger(id) || typeof method !== 'string') return null
  return value as RpcRequest
}

/**
 * Answer requests arriving on `input`, writing responses to `output`.
 *
 * Requests are answered concurrently and each response is written the moment it
 * is ready, so answers may come back in a different order from the questions.
 * That is not a compromise forced by the implementation - it is the property
 * the `id` field exists for, and the one that keeps a slow `reviews.diff` from
 * holding up the four cheap reads issued alongside it. A caller that cannot
 * cope with out-of-order responses is a caller that is not using the protocol.
 */
export function serveStdio({ input, output, onEnd }: StdioCarrierOptions): void {
  const write = (message: RpcResponse): void => {
    // One `write` per message rather than a stringify into a shared buffer:
    // Node serialises writes on a stream, so two responses finishing in the
    // same tick cannot interleave halfway through a line.
    output.write(`${JSON.stringify(message)}\n`)
  }

  const refuse = (id: number, message: string): void => {
    write({ id, error: new AppError('INVALID_INPUT', message).toSerialized() })
  }

  const answer = (line: string): void => {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      // Not fatal. A peer that has mangled one frame is more likely to be a
      // human poking at the pipe than a broken program, and closing the
      // connection would take the diagnosis away with it.
      refuse(NO_ID, 'A frame must be one JSON object on one line.')
      return
    }

    const request = asRequest(decoded)
    if (!request) {
      refuse(NO_ID, 'A request needs an integer id and a method.')
      return
    }

    // `handleRoutedRequest` never throws - that is its contract, and it is what makes
    // it usable here at all, since there is nowhere on a pipe to put an
    // exception. The catch is for the write.
    void handleRoutedRequest(request)
      .then(write)
      .catch((error: unknown) => {
        console.error('[stdio] could not answer a request', error)
      })
  }

  // Framing is `ndjson.ts`, shared with the client half of the protocol so that
  // the two ends cannot disagree about where a frame ends. What is left here is
  // only what a *server* does with a frame once it has one.
  readFrames(input, {
    onFrame: answer,
    // Refused rather than fatal, and the connection is kept: a peer that has
    // mangled one frame is more likely to be a human poking at the pipe than a
    // broken program, and hanging up would take the diagnosis away with it.
    onOverflow: () => {
      refuse(NO_ID, `A frame exceeded ${MAX_FRAME_BYTES} bytes without a newline.`)
    },
    onEnd: () => onEnd?.()
  })
}
