/**
 * Machines on the tailnet that are running GitWarren, found by asking them.
 *
 * "The PC appears on the Mac with no configuration" is M6's first verify line,
 * and the interesting half of it is *no configuration* rather than *appears*.
 * What that means is what the user has to type, not what this application gets
 * to do while nobody is watching - and the difference is the whole design of
 * this file.
 *
 * ## When it runs, and what it costs
 *
 * Only when somebody opens the Hosts screen, or presses "Look again". Never on
 * a timer, never at startup, never to render the home screen.
 *
 * Probing every peer on a schedule would be a connection to every machine on
 * the list, which is precisely what `core/hosts/pool.ts` exists to avoid and
 * what M4.3 refused to do for a home screen - and it would be worse here,
 * because the list includes machines that are not this application's business
 * at all.
 *
 * The bill, measured rather than guessed - and the guess was wrong, which is
 * why it is written out. The candidate set is peers from `tailscale status
 * --json` that are `Online` and carry the same `UserID` as `Self` - an
 * ownership check read from the same field the identity gate reads, not a
 * guess. Each candidate gets one HTTP `GET` with a one-second timeout, all of
 * them in parallel.
 *
 * A phone is not filtered out by its `OS`: a blocklist of operating systems is
 * the same shape as M5.2's blocklist of distribution names and goes stale the
 * same way. It is filtered out by *answering nothing* - and that is not the
 * instant refusal a local network would give. Measured against this tailnet, a
 * peer with nothing on the port takes **about 800 ms** to refuse, because
 * reaching it means NAT traversal or a relay before there is anything to
 * refuse with.
 *
 * Which makes the honest description of the cost the opposite of the one that
 * was written first: it is not "nine cheap refusals", it is **one probe
 * timeout, once, however many peers there are**, because they run together.
 * Measured at 1046 ms for a four-node tailnet of which one answers. That is
 * what `PROBE_TIMEOUT_MS` is really choosing, and it is why this runs when a
 * screen is opened rather than on a timer.
 *
 * ## Why it proposes and never adds
 *
 * `isLocalOnly` refuses the whole `hosts.` prefix so that a hub cannot be
 * talked into becoming a mesh; a discovery that inserted rows would walk around
 * that from the other side. So this answers a *list of candidates* and the
 * screen offers an Add button, which is a person deciding.
 *
 * It also has to say which of them you already have, and that is not a nicety.
 * `pc-wsl` is already an `ssh` row on this Mac from M4, and it is the same box:
 * M5.2 settled that one machine is one row even when two carriers reach it,
 * because `#/h/<instance>/…` routes by instance id and two rows bearing one id
 * make every remote route ambiguous. M4.1's collision report catches that on
 * connect and names the row it clashed with - correctly, and one step later
 * than a person needs. Here the instance id is already in hand, so the answer
 * can be "you have this, as `pc-wsl` over SSH" *before* anybody presses
 * anything.
 *
 * ## Why the probe is its own endpoint rather than `app.instance`
 *
 * `app.instance` is a method, and a method needs the socket, and the socket
 * needs an upgrade - which is a lot of ceremony to ask of nine phones that will
 * refuse the TCP connect anyway. More to the point, a probe is asked of
 * machines this install has no relationship with yet, and opening a carrier to
 * one is a stronger act than asking whether it is there.
 *
 * So it is a `GET` under `WEB_PREFIX`, behind the same gate as everything else:
 * on the tailnet authority it requires the owner's login, so only the owner's
 * own devices can learn that a machine runs GitWarren. What it answers is the
 * instance id, the version and the protocol - `HostIdentity`, the same shape
 * `app.instance` returns, because the two questions are the same question asked
 * before and after there is a connection.
 */
import { readTailnetIdentity } from '../tailnet.js'
import { getDatabase } from '../db/client.js'
import { hosts } from '../db/schema.js'
import { getInstanceId } from '../instance.js'
import { LINK_SERVER_PORT } from '../../shared/link-port.js'
import { WEB_PATHS } from '../../shared/web.js'
import type { DiscoveredPeer } from '../../shared/schemas.js'

/**
 * How long a peer has to answer before it is not a GitWarren.
 *
 * One second, and since every probe runs in parallel this is also the whole
 * duration of a scan - so it is the number that decides how long the Hosts
 * screen takes to show what is out there.
 *
 * A machine on the same tailnet that is running the daemon answers in tens of
 * milliseconds. One that is not takes about 800 ms to say so, measured, because
 * refusing means being reached first. One second is therefore only just enough,
 * and the cost of being wrong in the other direction is that a genuinely slow
 * machine has to be typed in by hand rather than offered.
 */
const PROBE_TIMEOUT_MS = 1_000

/** What a peer says about itself when asked over HTTP rather than a carrier. */
interface ProbeAnswer {
  instanceId?: unknown
  version?: unknown
  protocol?: unknown
}

/**
 * Ask one peer whether it is a GitWarren, and who.
 *
 * Never throws and never distinguishes between the ways of saying no. A refused
 * connection, a timeout, a 401 from a machine that does not think this is its
 * owner, a 404 from something else entirely on that port: all of them mean the
 * same thing to a list of proposals, which is that this peer is not offered.
 */
async function probePeer(dnsName: string): Promise<DiscoveredPeer | null> {
  const origin = `http://${dnsName}:${LINK_SERVER_PORT}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${origin}${WEB_PATHS.discover}`, {
      signal: controller.signal,
      // No credentials of any kind. The tailnet is the credential - see the
      // header - and sending a cookie from this install to another machine
      // would be offering a secret that means nothing there.
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    const answer = (await response.json()) as ProbeAnswer
    if (typeof answer.instanceId !== 'string' || answer.instanceId.length === 0) return null
    return {
      dnsName,
      origin,
      instanceId: answer.instanceId,
      version: typeof answer.version === 'string' ? answer.version : null,
      // Filled in by `discoverPeers`, which is the layer that has the host list.
      alreadyAdded: null
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every machine on this tailnet that answers, minus this one.
 *
 * Empty on a machine with no Tailscale, which is the same shape
 * `hosts.distros` uses so that a screen offers discovery when the answer is
 * non-empty and no code anywhere asks what platform it is on.
 *
 * This install is excluded by *instance id* rather than by name, which is the
 * only check that works: a machine reaches itself over its own MagicDNS name
 * perfectly well, and the result would be a proposal to add yourself as a host
 * - a row whose instance id equals `getInstanceId()` and which
 * `isAnsweredLocally` would then answer locally, making a "remote" machine that
 * silently is not one.
 */
export async function discoverPeers(): Promise<DiscoveredPeer[]> {
  const identity = await readTailnetIdentity()
  if (!identity) return []

  const online = identity.peers.filter((peer) => peer.online)
  const answers = await Promise.all(online.map((peer) => probePeer(peer.dnsName)))

  const mine = getInstanceId()
  const rows = getDatabase().select().from(hosts).all()
  const byInstance = new Map(
    rows.filter((row) => row.instanceId !== null).map((row) => [row.instanceId, row])
  )

  const found: DiscoveredPeer[] = []
  for (const answer of answers) {
    if (!answer) continue
    if (answer.instanceId === mine) continue
    const existing = byInstance.get(answer.instanceId)
    found.push({
      ...answer,
      // The row it would collide with, named. M4.1's report says this after an
      // insert and a connection; here it is said before either, because the
      // instance id arrived with the probe.
      alreadyAdded: existing ? existing.label : null
    })
  }

  // By name, so the list does not reshuffle between two looks at it. Peers come
  // out of a JSON object and their order is whatever Go's map iteration felt
  // like, which is a different order every time.
  return found.sort((a, b) => a.dnsName.localeCompare(b.dnsName))
}
