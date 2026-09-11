/**
 * Telling the owner of this data directory that an agent just wrote something.
 *
 * The MCP server opens SQLite directly and never routes reads through a running
 * GUI - `core/daemon-runtime.ts` argues that at length, and the property it buys
 * is that quitting GitWarren does not stop an agent working. The cost is that
 * `emitEvent` in this process reaches nobody: the bus is per process, and the
 * window that wants to know about this comment is in another one.
 *
 * So the poke goes out over the channel that is already there. The owner
 * publishes its pid and port in `daemon-runtime.json`, `core/web/token.ts`
 * writes the session token beside it with mode 0600, and this process runs as
 * the same user. One `POST`, one event name, no payload.
 *
 * ## Everything about this is best-effort, deliberately
 *
 * Nothing here may fail a tool call. The comment is already in the database
 * when this runs; a window that does not hear about it is fifteen seconds
 * behind, and a window that is not running is not behind at all. So every path
 * - no owner, no token, a refused connection, a 401 from an owner that restarted
 * and minted a new token - is the same answer: nothing happened, carry on. That
 * is also why it is not awaited by the caller.
 *
 * It is read fresh every time rather than resolved once at startup, and that is
 * not caution: an MCP server routinely outlives several GUI launches, so a port
 * or a token cached at startup would be wrong within the hour. `daemon-runtime.ts`
 * makes the same point about its own file.
 *
 * ## A host with no owner has no push, and that is the design rather than a gap
 *
 * A daemon spawned over `ssh` or `wsl.exe` binds nothing and writes no runtime
 * file - by design since M2, because a data directory has one owner and a stdio
 * daemon is not competing to be it. So an agent on a machine reached that way
 * finds no owner here, pokes nobody, and the GUI on the other end notices on its
 * next poll. The remedy is not a second mechanism: it is turning on "Reachable
 * on your tailnet", which gives that machine an owner and a socket to push down.
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { getWebTokenPath } from '../core/web/token.js'
import { LINK_SERVER_HOST } from '../shared/link-port.js'
import type { RpcEventName } from '../shared/rpc.js'
import { TOKEN_HEADER, WEB_PATHS } from '../shared/web.js'

/**
 * How long to give the owner before giving up.
 *
 * It is a request to a process on this machine that is already listening, so
 * the realistic range is single-digit milliseconds. The timeout exists for the
 * case the number cannot describe: a pid that is alive and a port that is held
 * by something that accepts connections and never answers. Short, because
 * nothing is waiting for the result and a hung socket per comment would
 * accumulate.
 */
const POKE_TIMEOUT_MS = 1_000

/**
 * Tell the owner, if there is one. Never throws, never rejects, never waited on.
 *
 * Called after the write has already succeeded, which is the same placement the
 * dispatcher uses for its own emit and for the same reason: an announcement
 * that something changed must not be able to report a failure for something
 * that worked.
 */
export function pokeOwner(event: RpcEventName): void {
  let owner: ReturnType<typeof readLiveDaemonRuntime>
  let token: string
  try {
    owner = readLiveDaemonRuntime()
    // No owner is the common case rather than an error: the GUI is not running,
    // or this daemon was spawned over a pipe and owns nothing.
    if (!owner || owner.linkPort === null) return
    token = readFileSync(getWebTokenPath(), 'utf8').trim()
  } catch {
    // An unreadable token file means the owner is mid-start or mid-quit. There
    // is nothing to report and nobody to report it to.
    return
  }

  const body = JSON.stringify({ event })
  const outgoing = httpRequest({
    host: LINK_SERVER_HOST,
    port: owner.linkPort,
    path: WEB_PATHS.notify,
    method: 'POST',
    timeout: POKE_TIMEOUT_MS,
    headers: {
      // Named explicitly because the gate requires it and a Node client sends
      // none by default. It is our own loopback origin, which is what
      // `origin.ts` demands of anything that is not a navigation - and a value
      // a web page could never forge onto its own request.
      Origin: `http://${LINK_SERVER_HOST}:${owner.linkPort}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      [TOKEN_HEADER]: token
    }
  })

  // Three ways to get nothing, all of them fine. A 401 is the interesting one:
  // it means the owner restarted and minted a new token since this file was
  // read, which is `token.ts` behaving exactly as designed.
  outgoing.on('error', () => {})
  outgoing.on('timeout', () => outgoing.destroy())
  // The response is consumed rather than ignored, so the socket is released
  // instead of being held by an unread body until the agent exits.
  outgoing.on('response', (response) => response.resume())

  outgoing.end(body)
}
