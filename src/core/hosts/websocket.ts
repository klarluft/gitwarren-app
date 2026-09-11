/**
 * A machine that is *listening*, rather than one we start a process on.
 *
 * The third carrier, and the first that is not a child process. `ssh.ts` and
 * `wsl.ts` both spawn `gitwarren serve --stdio` and own its lifetime; here the
 * daemon was already running before this app opened, and will still be running
 * after it quits. Everything that follows from `core/hosts/carrier.ts` -
 * `HostConnection`, `diagnosticTail`, `isLocalOnly`, the promise-shaped
 * `diagnostics()` - still applies, which is the point of M5 having extracted
 * it: this file is a *user* of that contract rather than a parallel one.
 *
 * ## What it does not have, and what it has instead
 *
 * **No stderr.** The other two carriers explain a failure from the last few
 * lines the far end printed. A socket has no such stream, so the explanation
 * comes from two other places: the HTTP status of a refused handshake, and the
 * close code of a connection that was open and stopped being. Both are more
 * precise than a tail of prose, and both arrive *after* the event that made
 * anybody ask - which is the M4.1 lesson in its socket-shaped form.
 *
 * `ws` reports a refused upgrade as an `error` carrying "Unexpected server
 * response: 401" and, separately and a moment later, an `unexpected-response`
 * event carrying the actual response object. Reading the reason synchronously
 * at the instant a request fails therefore gets the generic half. So
 * `diagnostics()` waits briefly, exactly as it does for `ssh`'s exit, and
 * answers with what the far end actually said - which for this carrier is
 * usually a sentence about *authorisation* and needs translating, because "401"
 * on the tailnet means "that machine does not think you are its owner" and
 * nothing about a token.
 *
 * **No exit.** A pipe ends when a process exits and the OS says so. A TCP
 * connection to a laptop that closed its lid ends when nobody is looking - the
 * classic half-open connection, which `core/rpc/websocket.ts` predicted at M3
 * would be "Tuesday" over the tailnet. So this end pings on its own timer and
 * gives up on a peer that has stopped answering.
 *
 * That is not symmetry with the server for its own sake. The server's heartbeat
 * protects the *server* from a browser tab that went away; this one is what
 * makes M6.5's `host.state` mean anything, because a machine that is switched
 * off with nobody looking at it is exactly the case the whole event channel was
 * built for. A clean shutdown closes the socket and is noticed immediately; a
 * yanked cable or a frozen machine is noticed within `LIVENESS_TIMEOUT_MS`.
 *
 * ## Why the Origin header is set by hand
 *
 * The far end requires `Origin` to match the authority the request arrived at
 * (`core/web/origin.ts`), because that check is what forecloses a page acting on
 * a server that did not serve it. A browser sets it; a Node client sends none,
 * and would be refused. Setting it here is not working around the check - it is
 * this client saying which server it believes it is talking to, which is
 * precisely what the check wants to hear and what a cross-origin page cannot
 * lie about.
 *
 * Identity is *not* set here and must not be. `Tailscale-User-Login` is stamped
 * by `tailscaled` on the far machine; a client that set it would be asserting
 * its own authorisation, which is the one thing a client never gets to do.
 */
import { Readable, Writable } from 'node:stream'
import { WebSocket } from 'ws'
import { createStdioClient } from '../rpc/stdio-client.js'
import { AppError } from '../../shared/errors.js'
import { EXIT_GRACE_MS, isLocalOnly, offline, type HostConnection } from './carrier.js'
import { LINK_SERVER_PORT } from '../../shared/link-port.js'
import { WEB_PATHS } from '../../shared/web.js'
import type { RpcEvent, RpcMethod, RpcParams, RpcResult } from '../../shared/rpc.js'

/**
 * How often this end pings, and how long silence may last before the connection
 * is treated as gone.
 *
 * Ten and thirty seconds. The cost is a two-byte frame six times a minute on a
 * connection the pool will close after ten idle minutes anyway, which is small
 * enough that the interesting number is the other one: thirty seconds is how
 * long a Hosts screen can be wrong about a machine that vanished without
 * closing its socket.
 *
 * Deliberately shorter than `WEBSOCKET_HEARTBEAT_MS` on the server side. That
 * one is 30 seconds because it is protecting a daemon from tabs that went away,
 * and being slow costs a held database handle. This one is protecting the
 * *truth on a screen*, which is what M6 is for.
 */
export const LIVENESS_PING_MS = 10_000
export const LIVENESS_TIMEOUT_MS = 30_000

export interface WebSocketHostOptions {
  /**
   * Where the daemon is: an origin, or an authority to be given a default.
   *
   * `http://pc-wsl.tail688c0c.ts.net:41427`, or `pc-wsl` - see `normaliseTarget`
   * on why both are accepted and what the second becomes.
   */
  target: string
  onClose?: (error: AppError) => void
  /** Swappable for tests, which have no tailnet. */
  open?: (url: string, options: { headers: Record<string, string> }) => WebSocket
}

/**
 * What a person typed, or what discovery found, turned into one URL.
 *
 * Both spellings are accepted, and the reason is that they come from different
 * places. Discovery (M6.6) has probed a peer and knows the scheme and port that
 * answered, so it stores the whole origin and nothing is guessed. A person
 * typing into the form has a machine name in their head and should not have to
 * know either - so a bare name becomes `http://<name>:41427`, which is spike
 * S6's fixed port and the scheme this tailnet actually serves.
 *
 * The stored value round-trips: whatever is in `hosts.target` is what is
 * connected to, so a host that worked yesterday is not re-guessed today.
 */
export function normaliseTarget(target: string): string {
  const trimmed = target.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new AppError('INVALID_INPUT', `"${target}" is not a machine name or an address.`)
  }
  if (!url.port) url.port = String(LINK_SERVER_PORT)
  // Origin only: the path, query and fragment of whatever was typed are not
  // part of where a daemon is, and carrying them would make the socket URL
  // depend on them.
  return url.origin
}

/** `http://host:41427` becomes `ws://host:41427/gitwarren/socket`. */
function socketUrl(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = WEB_PATHS.socket
  return url.toString()
}

/**
 * What a refused handshake means, in the words of the thing that refused it.
 *
 * The translation matters more here than for the other carriers, because the
 * status codes this far end returns are about *M6's* two questions and a person
 * reading "401" has no way to know which. A 401 over the tailnet is never about
 * a token - the token is not consulted on that authority at all - it is the
 * owner check, and the useful thing to say is what would make it pass.
 */
function describeStatus(status: number | undefined, target: string): string {
  switch (status) {
    case 401:
      return (
        `${target} does not recognise you as its owner. Both machines have to be signed in to ` +
        `the same Tailscale account.`
      )
    case 403:
      return (
        `${target} is not accepting connections from your tailnet. Turn on "Reachable on your ` +
        `tailnet" in GitWarren on that machine.`
      )
    case 404:
    case 426:
      return `${target} answered, but it is not a GitWarren that can be reached this way.`
    default:
      return status === undefined
        ? `${target} did not complete a connection.`
        : `${target} refused the connection (HTTP ${status}).`
  }
}

/**
 * What a connection that *was* open and closed means.
 *
 * 1006 is the code `ws` invents when a connection ended without a close frame,
 * which is every interesting case here: a machine switched off, a cable pulled,
 * a laptop asleep. It is reported as what it is rather than as a number,
 * because "the connection was lost" is true and "close code 1006" is a fact
 * about a specification.
 */
function describeClose(code: number, reason: string, target: string): string {
  if (reason) return `${target} closed the connection: ${reason}`
  if (code === 1006) return `The connection to ${target} was lost.`
  if (code === 1001) return `${target} went away.`
  return `${target} closed the connection (code ${code}).`
}

function describeSocketError(error: NodeJS.ErrnoException, target: string): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${target}. GitWarren may not be running there.`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${target} could not be found. It may be off the tailnet.`
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return `${target} did not answer.`
    default:
      return `Could not reach ${target}: ${error.message}`
  }
}

export function connectOverWebSocket({
  target,
  onClose,
  open = (url, options) => new WebSocket(url, options)
}: WebSocketHostOptions): HostConnection {
  const origin = normaliseTarget(target)
  const authority = new URL(origin).host

  let socket: WebSocket
  try {
    socket = open(socketUrl(origin), {
      // See the header: this is the client naming the server it believes it is
      // talking to, which is exactly what the far end's origin check wants.
      // Identity is deliberately absent - `tailscaled` stamps that.
      headers: { Origin: origin }
    })
  } catch (error) {
    throw offline(
      `Could not connect to ${authority}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  /**
   * The best explanation so far, and the one `diagnostics()` waits for.
   *
   * Two of them, because they arrive in the wrong order. `error` comes first
   * with the generic half ("Unexpected server response: 401") and
   * `unexpected-response` or `close` comes a moment later with the half worth
   * reading. The count takes the earliest and the explanation takes the latest,
   * which is the rule `core/hosts/pool.ts` already applies to its backoff
   * ladder for the same reason.
   */
  let reason: string | null = null
  let settled = false
  let resolveSettled: () => void = () => {}
  const explained = new Promise<void>((resolve) => {
    resolveSettled = () => {
      if (settled) return
      settled = true
      resolve()
    }
  })

  /**
   * The far end's stdout and stdin, as two in-memory streams.
   *
   * `createStdioClient` is written against a pair of streams and is deliberately
   * ignorant of how they were obtained - which is what let M5 reuse it for
   * `wsl.exe` unchanged, and what lets it be reused here for something that is
   * not a pipe at all. A socket delivers whole messages, so the framing
   * `ndjson.ts` does is redundant rather than wrong: a newline is appended on
   * the way out and each message arrives as one line on the way in.
   */
  const incoming = new Readable({ read() {} })

  /**
   * Frames written before the handshake finished.
   *
   * The pool opens a connection *because* something asked a question, so the
   * first request is always in flight before the socket is open - which
   * `web/carrier.ts` wrote down at M3 and this file had to learn again by
   * failing every first request in five milliseconds with "the connection is
   * not open". A carrier that refuses the request that caused it to exist is
   * not a carrier.
   *
   * Queued rather than rejected, and flushed on `open`. Nothing here needs a
   * bound: `createStdioClient` is the only writer, the pool is the only caller,
   * and a socket that never opens rejects everything through `onClose` with the
   * real reason - which is also why the queue is simply dropped rather than
   * drained on failure. This is the *first* request, never a backlog.
   */
  let pendingFrames: string[] | null = []

  const outgoing = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      // Trailing newline removed: it is `ndjson`'s framing and a WebSocket does
      // its own. Harmless either way - `JSON.parse` ignores trailing whitespace
      // - but sending it would put a byte on the wire that means nothing.
      const frame = String(chunk).trimEnd()

      if (pendingFrames !== null) {
        pendingFrames.push(frame)
        callback()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) {
        callback(new Error(`The connection to ${authority} is not open.`))
        return
      }
      socket.send(frame)
      callback()
    }
  })

  const client = createStdioClient({
    input: incoming,
    output: outgoing,
    onEvent: (event: RpcEvent) => {
      // Nothing yet. M6.5 is where an event from a host reaches a screen; the
      // hook is named here so that slice is a line in `pool.ts` rather than a
      // change to this file.
      void event
    },
    onClose: (error) => {
      resolveSettled()
      onClose?.(error)
    }
  })

  /**
   * Silence, measured from the last thing the far end said.
   *
   * Any frame counts - a pong, a response, an event - because what is being
   * asked is whether the connection still carries bytes, not whether the peer's
   * event loop is healthy. See the header on why this end pings at all when the
   * server already does.
   */
  let lastHeard = Date.now()
  const heard = (): void => {
    lastHeard = Date.now()
  }

  const liveness = setInterval(() => {
    if (Date.now() - lastHeard > LIVENESS_TIMEOUT_MS) {
      reason = `${authority} stopped responding.`
      // `terminate` rather than `close`: a close handshake with a peer that is
      // gone is a message into a void, and waiting for its reply is the delay
      // this timer exists to avoid. Same reasoning as the server's heartbeat.
      socket.terminate()
      return
    }
    if (socket.readyState === WebSocket.OPEN) socket.ping()
  }, LIVENESS_PING_MS)
  liveness.unref?.()

  socket.on('open', () => {
    heard()
    // Spliced rather than iterated, for the reason `web/carrier.ts` gives: a
    // frame written by something this flush wakes belongs to the open socket,
    // not to this loop.
    const backlog = pendingFrames ?? []
    pendingFrames = null
    for (const frame of backlog) socket.send(frame)
  })
  socket.on('pong', heard)

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    heard()
    // The protocol is JSON text. A binary frame is a different protocol, and
    // the client has no way to resynchronise - see `stdio-client.ts` on why a
    // reader that cannot tell where a message ends must give up rather than
    // guess.
    if (isBinary) return
    incoming.push(`${String(data)}\n`)
  })

  socket.on('unexpected-response', (_request, response) => {
    reason = describeStatus(response.statusCode, authority)
    resolveSettled()
    response.resume()
  })

  socket.on('error', (error: NodeJS.ErrnoException) => {
    // Only if nothing better has been said. `unexpected-response` carries the
    // status and `error` carries "Unexpected server response: 401" about the
    // same event, and the first of those is the one worth showing.
    if (reason === null) reason = describeSocketError(error, authority)
    client.close(reason)
  })

  socket.on('close', (code: number, raw: Buffer) => {
    clearInterval(liveness)
    // Anything still queued was never sent, and must not be: a request that did
    // not reach the far end is a request that failed, and `stdio-client.ts`
    // rejects it below with the reason. Retrying it here would be the carrier
    // deciding on the caller's behalf what a missing answer meant.
    pendingFrames = null
    if (reason === null) reason = describeClose(code, String(raw ?? ''), authority)
    resolveSettled()
    // Ends the read stream, which is what `stdio-client.ts` treats as the far
    // end going away - so every request in flight rejects with `HOST_OFFLINE`
    // and none of them is retried.
    incoming.push(null)
    client.close(reason)
  })

  return {
    request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> {
      if (isLocalOnly(method)) {
        return Promise.reject(
          new AppError(
            'INVALID_INPUT',
            `"${method}" is answered by this machine and is never sent to a host.`
          )
        )
      }
      return client.request(method, params)
    },

    close() {
      clearInterval(liveness)
      client.close('The connection to the host was closed.')
      socket.close()
    },

    isOpen() {
      return client.isOpen()
    },

    /**
     * Wait briefly for the explanation that is already on its way.
     *
     * The same shape and the same `EXIT_GRACE_MS` as the other two carriers,
     * bounding the same pathological case: this only ever runs on a connection
     * that has already failed, and the status or close code lands within a tick
     * of the failure that made anyone ask.
     */
    async diagnostics(): Promise<string> {
      if (!settled) {
        await Promise.race([
          explained,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, EXIT_GRACE_MS)
            timer.unref?.()
          })
        ])
      }
      return reason ?? ''
    }
  }
}
