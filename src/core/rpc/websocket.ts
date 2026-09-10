/**
 * The protocol on a WebSocket. The third carrier, and the first one with a
 * peer that can vanish without telling anyone.
 *
 * Almost everything `stdio.ts` had to invent is already here: a WebSocket
 * delivers whole messages, so there is no framing to do, no buffer to bound and
 * no partial line to hold. What is left is what a network adds.
 *
 * ## Why there is a heartbeat
 *
 * A pipe ends when the process at the other end exits, and the OS says so. A
 * TCP connection to a laptop that closed its lid ends when nobody is looking,
 * and both sides sit there believing in a socket that no longer exists - the
 * classic half-open connection. On loopback that is nearly impossible; over the
 * tailnet in M6 it is Tuesday. The server pings, and a client that has not
 * answered by the next tick is terminated rather than closed, because a close
 * handshake with a peer that is gone is a message into a void.
 *
 * The client pings nothing and answers everything: browsers reply to a ping in
 * the WebSocket implementation itself, below anything JavaScript can see, which
 * is exactly what makes this a liveness check on the *connection* rather than
 * on the page's event loop.
 *
 * ## What it does not do
 *
 * Decide anything. Every request goes through `handleRequest`, the same door
 * `main/ipc.ts` and `stdio.ts` use, and this file may not add a method, skip
 * validation or name an author - see the note at the top of `dispatcher.ts`.
 * Authentication happened before the upgrade was accepted (`web/server.ts`); a
 * socket that reaches here is one the user's browser was told the secret for,
 * and this file is not the place to second-guess that.
 */
import type { WebSocket } from 'ws'
import { handleRequest } from './dispatcher.js'
import { AppError } from '../../shared/errors.js'
import type { RpcRequest, RpcResponse } from '../../shared/rpc.js'

/**
 * How long a peer has to answer a ping before it is treated as gone.
 *
 * 30 seconds is comfortably longer than the renderer's 15-second poll, so a tab
 * that is doing its ordinary work never comes close to it, and short enough
 * that a dead socket does not hold a database handle open for minutes.
 */
const HEARTBEAT_MS = 30_000

/** Same as `stdio.ts`: the id used when a frame has no usable one. */
const NO_ID = 0

function asRequest(value: unknown): RpcRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, method } = value as Partial<RpcRequest>
  if (!Number.isInteger(id) || typeof method !== 'string') return null
  return value as RpcRequest
}

/**
 * Answer requests arriving on one socket.
 *
 * Like the stdio carrier, requests are answered concurrently and responses are
 * written the moment they are ready, so they may arrive in a different order
 * from the questions. That is what `id` is for.
 */
export function serveWebSocket(socket: WebSocket): void {
  let alive = true

  const write = (message: RpcResponse): void => {
    // A response for a socket that has closed is not an error worth logging on
    // every navigation - a tab going away mid-request is ordinary.
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  const refuse = (id: number, message: string): void => {
    write({ id, error: new AppError('INVALID_INPUT', message).toSerialized() })
  }

  socket.on('message', (data: unknown, isBinary: boolean) => {
    // The protocol is JSON text. A binary frame is not a mangled request, it is
    // a different protocol, and answering it as though it were ours would be a
    // guess.
    if (isBinary) {
      refuse(NO_ID, 'A message must be JSON text, not a binary frame.')
      return
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(String(data))
    } catch {
      refuse(NO_ID, 'A message must be one JSON object.')
      return
    }

    const request = asRequest(decoded)
    if (!request) {
      refuse(NO_ID, 'A request needs an integer id and a method.')
      return
    }

    // `handleRequest` never throws - that is its contract. The catch is for the
    // write, which can fail on a socket that closed between the two.
    void handleRequest(request)
      .then(write)
      .catch((error: unknown) => {
        console.error('[web] could not answer a request', error)
      })
  })

  socket.on('pong', () => {
    alive = true
  })

  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate()
      return
    }
    alive = false
    socket.ping()
  }, HEARTBEAT_MS)

  // `unref` so a stray interval cannot be the reason a daemon refuses to exit.
  heartbeat.unref?.()

  socket.on('close', () => {
    clearInterval(heartbeat)
  })

  socket.on('error', (error: Error) => {
    console.error('[web] socket error', error)
  })
}

export const WEBSOCKET_HEARTBEAT_MS = HEARTBEAT_MS
