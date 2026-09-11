/**
 * The carrier, from the browser's side.
 *
 * The preload's carrier has an easy job: `ipcRenderer.invoke` pairs a request
 * with its answer, and the other end is a process that cannot go away without
 * taking this one with it. Here there is a socket, so three things it never had
 * to think about have to be decided.
 *
 * **A request made before the socket is open.** The page renders immediately
 * and asks for the repository list in its first effect, which is long before a
 * WebSocket handshake completes. Those requests are queued and flushed on open.
 * The alternative - making `window.gitwarren` appear only once connected - would
 * mean the renderer's own "the bridge is missing" guard firing during a normal
 * load.
 *
 * **A request in flight when the socket closes.** Every one is rejected. Not
 * retried: a retry of `comments.reply` after an answer we did not see is a
 * second comment, and no carrier may decide that on the caller's behalf. This
 * is rule 2 of the plan in miniature - nothing is cached across a disconnect,
 * and a connection that is gone is shown as gone rather than papered over.
 *
 * **Getting back.** The socket reconnects with a backoff, so a laptop that
 * slept comes back on its own and SWR's next revalidation succeeds. Reconnect
 * is about the *next* request, never about the ones that were lost.
 *
 * Read coalescing is carried over from the preload unchanged, and matters more
 * here: two components asking the same question in the same tick is one frame
 * on the wire instead of two.
 *
 * A request is turned into text by `shared/rpc-wire.ts` rather than by
 * `JSON.stringify`, because one of them holds an image. See the note there -
 * since M4.4 the stdio client reads the same encoder, for the same reason.
 */
import { AppError } from '@shared/errors'
import {
  isReadMethod,
  resultOf,
  type Carrier,
  type RpcMethod,
  type RpcOutcome,
  type RpcParams,
  type RpcRequest,
  type RpcResponse,
  type RpcResult
} from '@shared/rpc'
import { WEB_PATHS } from '@shared/web'
import { frame } from '@shared/rpc-wire'

/** Backoff between reconnects: quick at first, then out of the way. */
const RETRY_MS = [250, 500, 1000, 2000, 5000] as const

interface Pending {
  resolve: (outcome: RpcOutcome) => void
  reject: (error: unknown) => void
}

function socketUrl(): string {
  // Same origin as the page, by construction: the server that sent this
  // document is the only one that will accept the upgrade, and building the URL
  // from `location` rather than from a constant is what keeps that true if the
  // app is ever mounted somewhere else.
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${WEB_PATHS.socket}`
}

export interface WebCarrier extends Carrier {
  /** Whether the socket is currently up, for the UI to show. */
  connected(): boolean
  /** Notified whenever that changes. Returns an unsubscribe function. */
  onConnectionChange(listener: (connected: boolean) => void): () => void
}

export function createWebCarrier(): WebCarrier {
  let socket: WebSocket | null = null
  let attempt = 0
  let nextId = 1

  const pending = new Map<number, Pending>()
  const queued: RpcRequest[] = []
  const listeners = new Set<(connected: boolean) => void>()

  const announce = (connected: boolean): void => {
    for (const listener of listeners) listener(connected)
  }

  const send = (request: RpcRequest): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame(request))
    else queued.push(request)
  }

  const failAllPending = (): void => {
    const lost = [...pending.values()]
    pending.clear()
    for (const entry of lost) {
      entry.reject(
        new AppError(
          'INTERNAL',
          'The connection to GitWarren was lost before this finished. Nothing was retried; try again.'
        )
      )
    }
  }

  const connect = (): void => {
    const opening = new WebSocket(socketUrl())
    socket = opening

    opening.addEventListener('open', () => {
      attempt = 0
      // Anything that arrived while the socket was opening. Splice rather than
      // iterate: a request queued by a listener during the flush belongs to the
      // socket that is now open, not to this loop.
      const backlog = queued.splice(0, queued.length)
      for (const request of backlog) opening.send(frame(request))
      announce(true)
    })

    opening.addEventListener('message', (event: MessageEvent<string>) => {
      let decoded: unknown
      try {
        decoded = JSON.parse(event.data)
      } catch {
        console.error('[carrier] a message from GitWarren was not JSON')
        return
      }

      const response = decoded as RpcResponse
      if (!response || typeof response.id !== 'number') return

      const entry = pending.get(response.id)
      // No entry means an answer to a request this page has already given up
      // on - after a reconnect, or a duplicate. Dropping it is correct; there
      // is nobody left to hand it to.
      if (!entry) return
      pending.delete(response.id)
      entry.resolve(response)
    })

    const dropped = (): void => {
      if (socket !== opening) return
      socket = null
      failAllPending()
      announce(false)

      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
      attempt += 1
      window.setTimeout(connect, delay)
    }

    opening.addEventListener('close', dropped)
    // `error` is always followed by `close`, so the reconnect is scheduled
    // there and this only stops the console from swallowing the reason.
    opening.addEventListener('error', () => {
      console.error('[carrier] the connection to GitWarren failed')
    })
  }

  connect()

  const inFlight = new Map<string, Promise<unknown>>()

  const ask = <M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    host?: string
  ): Promise<RpcResult<M>> => {
    const id = nextId++
    const answered = new Promise<RpcOutcome>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      // Spread rather than always set, so a local request is byte-for-byte the
      // frame it was before hosts existed - which is what lets a tab served by
      // an older daemon go on working.
      send({ id, method, params, ...(host === undefined ? {} : { host }) })
    })

    // A response carries whatever its method returns, and the socket cannot
    // know which method that was - the id is the only thing tying the two
    // together. `RpcResult<M>` is recovered here, at the one point where `M` is
    // still in scope, exactly as the preload's `invoke` does it.
    return answered.then((outcome) => resultOf(outcome) as RpcResult<M>)
  }

  return {
    request<M extends RpcMethod>(
      method: M,
      params: RpcParams<M>,
      host?: string
    ): Promise<RpcResult<M>> {
      if (!isReadMethod(method)) return ask(method, params, host)

      // Keyed by host as well as method: see the same note in the preload.
      const key = `${host ?? ''}:${method}:${JSON.stringify(params ?? null)}`
      const existing = inFlight.get(key) as Promise<RpcResult<M>> | undefined
      if (existing) return existing

      const promise = ask(method, params, host).finally(() => inFlight.delete(key))
      inFlight.set(key, promise)
      return promise
    },
    connected: () => socket?.readyState === WebSocket.OPEN,
    onConnectionChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
