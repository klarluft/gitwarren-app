/**
 * The protocol from the asking side of a pipe.
 *
 * `stdio.ts` has answered requests on a byte stream since M2. This is its
 * mirror: it *makes* them. Nothing needed it until M4, because until M4 the
 * process holding the questions and the process holding the answers were always
 * the same one, or were joined by Electron IPC, which pairs a call with its
 * answer itself.
 *
 * Deliberately ignorant of `ssh`. It is handed two streams and never learns how
 * they were obtained, which is what lets M5 reuse it unchanged with `wsl.exe`
 * in front - the difference between those two milestones is a child process and
 * an argument vector, and none of that belongs in the protocol.
 *
 * ## The three things a pipe has that a function call does not
 *
 * **Answers come back in any order.** That is the property `id` exists for, and
 * the server takes advantage of it: a slow `reviews.diff` does not hold up the
 * cheap reads issued alongside it. So responses are matched through a map, and
 * a client that assumed FIFO would deadlock the first time a screen opened.
 *
 * **The far end can vanish.** A laptop sleeps, a network drops, `ssh` exits.
 * Every request in flight is rejected with `HOST_OFFLINE` and *none of them is
 * retried* - see below, it is the most important decision in this file.
 *
 * **Nothing is authenticated here.** The stream is trusted because of how it
 * was obtained: `ssh` authenticated the far end before this module saw a byte.
 * A carrier that had to check identities would be a different design, and M6's
 * WebSocket listener is where that question actually gets answered.
 *
 * ## Why a lost request is never retried
 *
 * When a connection dies mid-flight there are two possibilities and no way to
 * tell them apart: the daemon never saw the request, or it did the work and the
 * reply died on the way back. Retrying is safe in the first case and, for
 * `comments.reply`, posts a second comment in the second.
 *
 * A carrier may not make that choice on the caller's behalf, so it makes the
 * conservative one always: the request fails with `HOST_OFFLINE` and the person
 * decides. Reconnection is about the *next* request, never about the lost ones.
 * The web carrier settled this the same way at M3; the note is repeated here
 * because this is where it would be most tempting to be clever.
 */
import { readFrames } from './ndjson.js'
import { AppError } from '../../shared/errors.js'
import {
  isRpcEvent,
  resultOf,
  type RpcEvent,
  type RpcMethod,
  type RpcOutcome,
  type RpcParams,
  type RpcRequest,
  type RpcResponse,
  type RpcResult
} from '../../shared/rpc.js'

export interface StdioClientOptions {
  /** The far end's stdout: responses and events. */
  input: NodeJS.ReadableStream
  /** The far end's stdin: requests. */
  output: NodeJS.WritableStream
  /**
   * A push from the host. Nothing sends one before M6; the hook is here because
   * a reader that could not tell an event from an answer would have to be
   * rewritten to accept one, and this way the message simply arrives.
   */
  onEvent?: (event: RpcEvent) => void
  /**
   * The far end stopped answering, for any reason. Called once, after the
   * pending requests have been rejected, so a pool can drop this connection and
   * decide about reconnecting.
   */
  onClose?: (error: AppError) => void
}

export interface StdioClient {
  /**
   * Ask, and wait. Rejects with the `AppError` the far end reported, or with
   * `HOST_OFFLINE` if the connection went away first.
   */
  request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
  /** Stop, rejecting anything in flight. Idempotent. */
  close(reason?: string): void
  /** Whether this client still believes it can carry a request. */
  isOpen(): boolean
}

interface Pending {
  settle: (outcome: RpcOutcome) => void
}

/**
 * Speak the protocol over a pair of streams.
 *
 * The returned client is single-connection: when the pipe dies it stays dead,
 * `isOpen()` goes false and every later `request` fails immediately. Deciding
 * to build another one is a policy question about a *host*, not about a stream,
 * and it lives one level up in `core/hosts/pool.ts`. Keeping reconnection out
 * of here is what makes this module testable with two in-memory streams and no
 * timers at all.
 */
export function createStdioClient({
  input,
  output,
  onEvent,
  onClose
}: StdioClientOptions): StdioClient {
  const pending = new Map<number, Pending>()
  let nextId = 1
  let closed: AppError | null = null

  /**
   * Fail everything in flight and refuse everything after.
   *
   * Called for a dead stream, a peer that broke framing, and an explicit
   * `close`, because from a caller's point of view those are the same event:
   * the answer is not coming. The map is emptied before the callbacks run so
   * that a `settle` which starts a new request cannot see a stale entry.
   */
  const shutdown = (error: AppError): void => {
    if (closed) return
    closed = error

    const inFlight = [...pending.values()]
    pending.clear()
    for (const { settle } of inFlight) settle({ error: error.toSerialized() })

    onClose?.(error)
  }

  const receive = (line: string): void => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // The far end is not speaking the protocol. Unlike the server, which can
      // refuse one frame and read on, a client has no way to resynchronise: it
      // does not know whether the garbage was a whole frame or the first half
      // of one, so every id it is still waiting for is now in doubt.
      //
      // In practice this is the shape a misconfigured host takes - a shell
      // profile that prints a banner on a non-interactive login, an `ssh`
      // option that logs to stdout - so the message names that, because the
      // literal complaint ("could not parse JSON") sends people to look at
      // GitWarren rather than at their `.bashrc`.
      shutdown(
        new AppError(
          'HOST_OFFLINE',
          'The host sent something that is not part of the protocol. This is usually a login ' +
            'script printing to stdout on the host; GitWarren needs that stream to itself.'
        )
      )
      return
    }

    if (typeof message !== 'object' || message === null) return

    if (isRpcEvent(message as RpcEvent)) {
      onEvent?.(message as RpcEvent)
      return
    }

    const { id, ...outcome } = message as RpcResponse
    const waiting = pending.get(id)
    // An answer to a request we are not waiting for. Dropped rather than
    // treated as a fault: it is what a duplicated id or a very late reply after
    // a timeout looks like, and neither is worth tearing a connection down for.
    if (!waiting) return
    pending.delete(id)
    waiting.settle(outcome)
  }

  readFrames(input, {
    onFrame: receive,
    onOverflow: (bytes) => {
      shutdown(
        new AppError('HOST_OFFLINE', `The host sent ${bytes} bytes without completing a message.`)
      )
    },
    onEnd: () => {
      shutdown(new AppError('HOST_OFFLINE', 'The connection to the host closed.'))
    }
  })

  // A pipe whose reader has gone is an `EPIPE` on the next write, which as an
  // unhandled 'error' event would take the whole GUI down. It is the same
  // event as `end` as far as anyone here is concerned.
  input.on('error', (error: Error) => {
    shutdown(new AppError('HOST_OFFLINE', `The connection to the host failed: ${error.message}`))
  })
  output.on('error', (error: Error) => {
    shutdown(new AppError('HOST_OFFLINE', `The connection to the host failed: ${error.message}`))
  })

  return {
    request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
      if (closed) return Promise.reject(closed)

      const id = nextId++
      const request: RpcRequest = { id, method, ...(params === undefined ? {} : { params }) }

      return new Promise<RpcResult<M>>((resolve, reject) => {
        pending.set(id, {
          settle: (outcome) => {
            // `resultOf` is the shared unwrapping every carrier uses, so a
            // `NOT_FOUND` raised on a daemon over `ssh` reaches a React
            // component as the same `AppError` a local call would have thrown -
            // code, message and field errors intact.
            try {
              resolve(resultOf(outcome) as RpcResult<M>)
            } catch (error) {
              // `resultOf` throws the deserialised `AppError`; `AppError.from`
              // is the guarantee that a rejection is always an `Error`, however
              // odd the thing on the wire turned out to be.
              reject(AppError.from(error))
            }
          }
        })

        try {
          // One `write` per message: Node serialises writes on a stream, so two
          // requests issued in the same tick cannot interleave halfway through
          // a line.
          output.write(`${JSON.stringify(request)}\n`)
        } catch (error) {
          pending.delete(id)
          reject(
            new AppError(
              'HOST_OFFLINE',
              `Could not send to the host: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        }
      })
    },

    close(reason = 'The connection to the host was closed.') {
      shutdown(new AppError('HOST_OFFLINE', reason))
    },

    isOpen() {
      return closed === null
    }
  }
}
