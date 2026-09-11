/**
 * Whether this install is on the tailnet, held in one place because three
 * things need the same answer and they are in different layers.
 *
 * The gate in `core/web/handler.ts` needs it per request, to know which
 * authority it may answer to and whose login counts. A settings panel needs it
 * to draw a switch. And `daemon-runtime.json` needs it written down, because
 * the MCP process is a *different process* and `webUrl` on a tool result is
 * decided there - see `mcp/gui-link.ts`.
 *
 * Without this module each of those would shell out to `tailscale` on its own
 * schedule and they would disagree, which on the gate would mean answering for
 * an authority the panel says is off.
 *
 * ## The source of truth is the machine, and this is a cache with an owner
 *
 * `tailscale serve` is machine state: it survives a GitWarren restart, and the
 * user may turn it off from a terminal without telling anybody. So `refresh()`
 * re-reads it from `tailscale serve status` rather than remembering what this
 * process last did, and it is called at startup - which is what makes a second
 * launch pick up an exposure the first one left running instead of showing a
 * switch that disagrees with the machine.
 *
 * What is cached is only the *last read*, and it is cached because the gate asks
 * on every request and a process spawn per request is not a gate, it is a
 * denial of service with good intentions.
 */
import {
  readTailnetIdentity,
  serveTailnet,
  tailnetServeOrigin,
  unserveTailnet
} from '../tailnet.js'
import { writeDaemonExposure } from '../daemon-runtime.js'
import { AppError } from '../../shared/errors.js'
import type { TailnetGate } from './origin.js'
import type { TailnetExposure } from '../../shared/schemas.js'

const UNAVAILABLE: TailnetExposure = {
  available: false,
  dnsName: null,
  login: null,
  exposed: false,
  webRoot: null
}

let current: TailnetExposure = UNAVAILABLE
/** The mount this install serves the app at: `/app/` or `/`. */
let mount = '/'
let servedPort = 0

/**
 * Tell this module which shell it is in, before anything asks.
 *
 * Called once by whichever process owns the port. It is a setter rather than a
 * parameter on every call because the gate asks from inside a request handler
 * that has no business knowing about mounts.
 */
export function configureExposure(options: { mount: string; port: number }): void {
  mount = options.mount
  servedPort = options.port
}

/** The last read. Synchronous, because a request handler cannot wait. */
export function exposureNow(): TailnetExposure {
  return current
}

/**
 * The gate's view of it: the authority to accept and the login to demand.
 *
 * Null whenever this install is not exposed, which is what makes the whole
 * tailnet half of `handler.ts` vanish for a machine with the switch off.
 */
export function tailnetGate(): TailnetGate | null {
  if (!current.exposed || !current.dnsName || !current.login || !current.webRoot) return null
  const url = new URL(current.webRoot)
  return {
    authority: url.host,
    login: current.login,
    scheme: url.protocol === 'https:' ? 'https' : 'http'
  }
}

function rootFor(origin: string): string {
  // `new URL` rather than concatenation, so a mount of `/` does not produce a
  // double slash and `/app/` keeps its trailing one - which matters, because
  // the web build's asset URLs are relative to the document's own path.
  return new URL(mount, origin).toString()
}

/**
 * Ask the machine what is true, and publish it.
 *
 * Everything that changes exposure goes through here rather than updating the
 * cache itself, so there is one path from "the machine" to "what this process
 * believes" and it cannot be skipped.
 */
export async function refreshExposure(): Promise<TailnetExposure> {
  const identity = await readTailnetIdentity()
  if (!identity) {
    current = UNAVAILABLE
    writeDaemonExposure(null)
    return current
  }

  const origin = servedPort === 0 ? null : await tailnetServeOrigin(servedPort)
  current = {
    available: true,
    dnsName: identity.dnsName,
    login: identity.login,
    exposed: origin !== null,
    webRoot: origin === null ? null : rootFor(origin)
  }
  writeDaemonExposure(current.webRoot)
  return current
}

/**
 * Turn it on or off, and answer with what the machine then says.
 *
 * Deliberately not "answer with what was asked for". `tailscale serve --https`
 * on a tailnet without certificates never returns (M6.0), so the request and
 * the result genuinely differ, and a panel that showed the request would tell a
 * user they were reachable when they were not.
 */
export async function setExposed(exposed: boolean): Promise<TailnetExposure> {
  let refusal = ''
  if (servedPort !== 0) {
    if (exposed) refusal = (await serveTailnet(servedPort)).failure
    else await unserveTailnet(servedPort)
  }

  const now = await refreshExposure()
  // Asked for and did not get. Thrown rather than returned quietly, because the
  // caller is a switch somebody just flipped: a control that springs back with
  // no explanation is the worst version of this, and the remedy is usually one
  // command that `tailscale` has already named.
  //
  // M6.4 found the case on a real Linux box. `tailscale serve` needs root there
  // unless `tailscale set --operator=$USER` has been run once, and it refuses
  // with *Access denied: serve config denied* plus that exact command. On macOS
  // the same call succeeds as the user, so this is invisible until somebody
  // runs GitWarren on the machine most likely to be a host.
  if (exposed && !now.exposed) {
    throw new AppError(
      'INTERNAL',
      refusal
        ? `Tailscale would not put this machine on your tailnet. ${refusal}`
        : 'Tailscale would not put this machine on your tailnet.'
    )
  }
  return now
}
