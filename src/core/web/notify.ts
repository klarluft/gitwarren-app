/**
 * The one write this server answers, and the reason it is allowed to exist.
 *
 * `core/web/handler.ts` says, in as many words, that everything behind its gate
 * is a read and that this is what keeps the whole file answering `GET` and
 * `HEAD` and refusing every other method outright. That was true through M5 and
 * it stops being true here, so the exception is written down rather than
 * slipped in.
 *
 * ## What it is for
 *
 * An agent writing a comment does it in the *MCP process*, which is a different
 * OS process from the GUI: `core/daemon-runtime.ts` explains at length why the
 * MCP server opens SQLite directly and never routes reads through the owner -
 * quit GitWarren and the agent keeps working, which is a property worth more
 * than a push. But that also means `emitEvent` in the MCP process reaches
 * nobody, and a window that has to wait fifteen seconds to see what an agent
 * just wrote is the thing this milestone exists to fix.
 *
 * So the agent's process dials the owner. Everything it needs is already
 * published: `daemon-runtime.json` names the owning pid and the port it is
 * serving on, and `core/web/token.ts` writes the session token next to it with
 * mode 0600. The channel is this handler. Nothing new is bound, nothing new is
 * watched, and the poke is one request that either lands or does not.
 *
 * ## Why this is not a hole
 *
 * Three locks, and the interesting part is what each one is *for*.
 *
 *  - **The token.** The same 0600 file, read by a process running as the user.
 *    That is not authentication of a person - `token.ts` is explicit that the
 *    principal on loopback is "whoever is at this machine" - it is the check
 *    that the caller was pointed at GitWarren rather than merely knowing the
 *    port.
 *  - **A loopback `Host` and our own `Origin`, both required.** This is the
 *    lock that matters, because the attacker worth worrying about on a loopback
 *    port is a web page (see `origin.ts` on DNS rebinding). A page cannot set
 *    `Host`, cannot set a custom header without a preflight this server never
 *    answers, and `SameSite=Strict` means its request would arrive without the
 *    cookie anyway. Three independent reasons it fails, which is the right
 *    number for the only endpoint that is not a read.
 *  - **A closed vocabulary.** The body may name an event and nothing else. Not
 *    because a bad name would be dangerous, but because "the set of things that
 *    can be put on the bus" should be decided here rather than by whatever
 *    string a caller sent.
 *
 * And the honest bound on all of it: a local process running as the user can
 * already open the database. The worst this endpoint grants is making a window
 * re-read something it could have caused by writing a row.
 *
 * ## Tailnet requests are refused here, always
 *
 * The gate in `handler.ts` admits a request on either of two grounds from M6.3
 * - loopback with the token, or the tailnet with the owner's login. This
 * endpoint takes only the first. A poke is a statement about *this machine's*
 * processes; a peer on the tailnet that wanted this install to re-read
 * something would be asking it to believe a claim about a database it cannot
 * see. What a remote install does instead is emit on its own bus, which travels
 * as an `RpcEvent` on the carrier that is already open.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { emitEvent } from '../events.js'
import { RPC_EVENTS, type RpcEventName } from '../../shared/rpc.js'

/** The names this endpoint will put on the bus. Everything else is refused. */
const ACCEPTED: ReadonlySet<string> = new Set<RpcEventName>([
  RPC_EVENTS.reviewsChanged,
  RPC_EVENTS.commentsChanged
  // `host.state` is deliberately absent. It is minted by this install's own
  // pool from a connection it is holding, and nothing outside this process has
  // any evidence about it.
])

/**
 * How much of a body to read before giving up.
 *
 * A poke is about sixty bytes. The cap is here because this is the one path
 * that reads a request body at all, and a body with no end is otherwise a
 * process that grows until it dies - the same reasoning as `onOverflow` in
 * `core/rpc/ndjson.ts`, on a much smaller scale.
 */
const MAX_BODY_BYTES = 1024

/**
 * The request body, or null if it was too large or the connection failed.
 *
 * The oversized case **stops accumulating but does not hang up**, and that
 * ordering was found by a test rather than by reading. Destroying the request
 * the moment the cap is passed takes the socket down before the `413` can be
 * written, so the caller sees a connection reset - "other side closed" - where
 * it should have seen a status it could read. A refusal nobody receives is not
 * a refusal; hanging up is the caller's answer, and it comes after the answer.
 *
 * So `overflowed` guards the accumulation, which is what bounds the memory, and
 * the promise settles immediately rather than waiting for an `end` an endless
 * body will never send. `serveNotify` destroys the connection once it has
 * replied.
 */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = ''
    let overflowed = false

    request.on('data', (chunk: Buffer) => {
      if (overflowed) return
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY_BYTES) {
        overflowed = true
        resolve(null)
      }
    })
    request.on('end', () => {
      if (!overflowed) resolve(body)
    })
    request.on('error', () => {
      if (!overflowed) resolve(null)
    })
  })
}

/**
 * Take one poke. The caller has already checked the token, the host and the
 * origin - this decides only whether the body names something real.
 *
 * Answers 204 for a name it accepted and 400 for anything else. Deliberately
 * not 200-with-a-body: there is nothing to say, and a caller that waits for a
 * payload here would be a caller doing something wrong.
 */
export async function serveNotify(
  request: IncomingMessage,
  response: ServerResponse,
  headers: Record<string, string>
): Promise<void> {
  const body = await readBody(request)
  if (body === null) {
    // Answer, then hang up - in that order, and `Connection: close` so the
    // client is not left waiting for a keep-alive turn on a socket carrying the
    // rest of a body nobody is reading.
    response.writeHead(413, { ...headers, Connection: 'close' }).end()
    request.destroy()
    return
  }

  let event: unknown
  try {
    event = (JSON.parse(body) as { event?: unknown }).event
  } catch {
    response.writeHead(400, headers).end()
    return
  }

  if (typeof event !== 'string' || !ACCEPTED.has(event)) {
    response.writeHead(400, headers).end()
    return
  }

  // No host on it. This is a local process telling the local owner about the
  // local database, which is exactly what "absent means this install" means
  // everywhere else - see `RpcEvent.host`.
  emitEvent({ event, data: null })
  response.writeHead(204, headers).end()
}

/** Exported for the test, which is about what the vocabulary is. */
export const ACCEPTED_EVENTS = ACCEPTED
