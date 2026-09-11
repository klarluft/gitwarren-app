/**
 * What Tailscale knows, asked rather than assumed.
 *
 * Rule 3 of the plan is that Tailscale is discovery and identity and never a
 * dependency, and this module is where that is kept honest: everything here
 * answers "not available" rather than throwing, and every caller is written so
 * that a machine with no Tailscale on it is an ordinary machine with one fewer
 * option on a settings panel. SSH stays the universal fallback for own
 * machines.
 *
 * Three questions, and they are separate because they fail separately.
 *
 *  - **Who am I on the tailnet, and who owns it?** `tailscale status --json`,
 *    `Self` and `User`. This is the identity half of M6, and it is the thing
 *    the gate compares an incoming `Tailscale-User-Login` against.
 *  - **Which of my peers are worth asking about?** The same answer's `Peer`
 *    map, filtered to this user's own online machines. That is M6.6.
 *  - **Am I reachable, and at what URL?** `tailscale serve`, and the URL is
 *    read back from what it reports rather than assembled from a template.
 *
 * ## Why the URL is read rather than written
 *
 * The plan spells `webUrl` as `https://<host>.<tailnet>.ts.net/review/4/…`, and
 * spike M6.0 found that a tailnet can simply not have HTTPS: `tailscale serve
 * --https` hangs, and `tailscale cert` says *your Tailscale account does not
 * support getting TLS certs* - certificates are a tailnet-wide switch, not a
 * property of the machine. A URL minted by convention would then be a URL that
 * does not open, handed to an agent to hand to a person, with nothing anywhere
 * having warned.
 *
 * So `serveTailnet` asks for HTTPS, falls back to plain HTTP, and **reports
 * which one it got**. It is the rule `core/mcp-launcher.ts` follows for the
 * launcher path: a fact from the machine that knows it beats a string that is
 * usually right. A tailnet that turns HTTPS on later gets it on the next toggle
 * with no code change, because nothing here decided in advance.
 *
 * Plain HTTP over a tailnet is not plaintext on a network. WireGuard encrypts
 * between the two machines a layer down, and `tailscale serve` - unlike
 * `funnel`, which is a non-goal - never leaves the tailnet. What is lost
 * without a certificate is the browser's padlock and nothing underneath it.
 *
 * ## Why the port is the same 41427
 *
 * Spike S6 chose that number so a link written on one machine on Tuesday opens
 * on another on Thursday, and the tailnet is the first place that promise is
 * cashed. A different port for the tailnet would be a second number to defend,
 * and the port is not what makes the two authorities different - the `Host`
 * header is.
 */
import { execFile } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import { LINK_SERVER_HOST } from '../shared/link-port.js'

const run = promisify(execFile)

/**
 * How long to let a `tailscale` invocation run.
 *
 * `status` and `serve status` talk to a local daemon over a socket and answer
 * in milliseconds. `serve` itself may have to provision a certificate, which is
 * a network round trip to Let's Encrypt - and on a tailnet without HTTPS
 * enabled it simply never returns, which is exactly what M6.0 found. So the
 * timeout is not a safety net here, it is the mechanism by which "HTTPS is not
 * available" is discovered.
 */
const STATUS_TIMEOUT_MS = 5_000
const SERVE_TIMEOUT_MS = 20_000

/**
 * Where `tailscale` is, when it is not on PATH.
 *
 * The Mac app ships its CLI inside the bundle and only symlinks it into
 * `/usr/local/bin` if the user asks, so PATH alone would report "no Tailscale"
 * on a machine that is on the tailnet right now. Windows puts it under Program
 * Files and does not add it to a GUI process's PATH either. Absolute paths
 * rather than a shell, because a shell would mean quoting.
 */
const KNOWN_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  ],
  win32: [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale']
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The `tailscale` binary, or null when this machine has none.
 *
 * Cached for the life of the process. Installing Tailscale while GitWarren is
 * open is real but rare, and the failure it causes - a settings panel that
 * still says "not available" until the app restarts - is both visible and
 * self-explanatory. A negative answer is cached too, which is the half that
 * matters: this is asked on every settings render and a filesystem walk per
 * render is the cost this avoids.
 */
let resolved: { path: string | null } | null = null

export async function tailscaleBinary(): Promise<string | null> {
  if (resolved) return resolved.path

  const onPath = process.env.PATH
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const candidates: string[] = []
  for (const directory of (onPath ?? '').split(delimiter)) {
    if (directory) candidates.push(join(directory, `tailscale${suffix}`))
  }
  candidates.push(...(KNOWN_PATHS[process.platform] ?? []))

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      resolved = { path: candidate }
      return candidate
    }
  }
  resolved = { path: null }
  return null
}

/** For tests, and for nothing else: the cache is otherwise for the process. */
export function forgetTailscaleBinary(): void {
  resolved = null
}

/**
 * One `tailscale` invocation. Never throws.
 *
 * Two shapes of answer, because the two kinds of caller want different things.
 *
 * A *read* - `status`, `serve status` - wants stdout or nothing. Every way of
 * failing is the same answer to it: the tailnet is not available here.
 * `tailscale` distinguishes "not installed", "not logged in" and "daemon not
 * running" in its prose, and none of those changes what this application does,
 * which is offer the tailnet or not offer it.
 *
 * A *write* - `serve` - is different, and M6.4 found out why on a real Linux
 * box. `tailscale serve` requires root there unless somebody has run
 * `tailscale set --operator=$USER`, and it refuses with *Access denied: serve
 * config denied* plus the exact command that fixes it. Swallowing that leaves
 * a settings switch that flips back with no explanation, which is the worst
 * possible version: the user has done nothing wrong, the remedy is one command,
 * and the app has said nothing. So the failure text is kept and handed up.
 */
async function tailscale(args: string[], timeout: number): Promise<string | null> {
  return (await runTailscale(args, timeout)).stdout
}

interface TailscaleRun {
  /** Stdout when it succeeded, null when it did not. */
  stdout: string | null
  /** What it said when it failed, trimmed. Empty when there was nothing. */
  failure: string
}

async function runTailscale(args: string[], timeout: number): Promise<TailscaleRun> {
  const binary = await tailscaleBinary()
  if (binary === null) {
    return { stdout: null, failure: 'Tailscale is not installed on this machine.' }
  }
  try {
    const { stdout } = await run(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 })
    return { stdout, failure: '' }
  } catch (error) {
    // `tailscale` writes its refusals to stderr and, usefully, includes the
    // command that would work. `execFile`'s error carries both streams.
    const { stderr, stdout } = error as { stderr?: string; stdout?: string }
    return { stdout: null, failure: `${stderr ?? ''}${stdout ?? ''}`.trim() }
  }
}

/** One machine on the tailnet, as this install cares about it. */
export interface TailnetPeer {
  /** MagicDNS name with the trailing dot removed: `pc-wsl.tail688c0c.ts.net`. */
  dnsName: string
  /** The short name, for a label a person recognises. */
  hostName: string
  /** `Windows`, `linux`, `iOS`… as Tailscale spells it. Shown, never branched on. */
  os: string
  online: boolean
}

export interface TailnetIdentity {
  /** This machine's MagicDNS name, without the trailing dot. */
  dnsName: string
  /**
   * The login of whoever owns this node - `michal-wrzosek@github`.
   *
   * This is the whole of M6's authorisation: a request carrying
   * `Tailscale-User-Login` equal to this is the owner, and anything else is
   * refused before dispatch. The plan calls it "same Tailscale login as the
   * owner" and it is deliberately not a list.
   */
  login: string
  /** Every other node with the same owner. Unfiltered by OS - see `peers()`. */
  peers: TailnetPeer[]
}

interface StatusNode {
  DNSName?: string
  HostName?: string
  OS?: string
  Online?: boolean
  UserID?: number
}

/**
 * Who this machine is on the tailnet, and which machines are its owner's.
 *
 * Null covers everything: no Tailscale, not logged in, daemon down, output this
 * version does not produce. No caller can act on the distinction - the answer
 * is "the tailnet is not available here" in all of them - which is the same
 * shape `readLiveDaemonRuntime` settled on for its own file.
 *
 * Read fresh on every call rather than cached. A laptop joins and leaves
 * networks, a node is renamed in the admin console, a peer comes online: all of
 * those change this answer while the process runs, and a stale identity here
 * would be a gate comparing against a login that is no longer the owner's.
 */
export async function readTailnetIdentity(): Promise<TailnetIdentity | null> {
  const output = await tailscale(['status', '--json'], STATUS_TIMEOUT_MS)
  if (output === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  const status = parsed as {
    BackendState?: string
    Self?: StatusNode
    Peer?: Record<string, StatusNode>
    User?: Record<string, { LoginName?: string }>
  }

  // `Running` is the only state in which any of this means anything. `Stopped`,
  // `NeedsLogin` and `NoState` all produce a `Self` with a name in it, which is
  // exactly the sort of half-answer that would make a gate compare against a
  // login for a tailnet this machine is not currently on.
  if (status.BackendState !== 'Running') return null

  const self = status.Self
  const userId = self?.UserID
  if (!self?.DNSName || userId === undefined) return null

  const login = status.User?.[String(userId)]?.LoginName
  if (!login) return null

  const peers: TailnetPeer[] = []
  for (const peer of Object.values(status.Peer ?? {})) {
    // Same owner only. A tailnet may be shared, and a node belonging to someone
    // else is not a machine this install has any business proposing - the
    // authorisation decision and the discovery decision read the same field, on
    // purpose, so they cannot drift apart.
    if (peer.UserID !== userId || !peer.DNSName) continue
    peers.push({
      dnsName: trimDot(peer.DNSName),
      hostName: peer.HostName ?? trimDot(peer.DNSName).split('.')[0] ?? '',
      os: peer.OS ?? '',
      online: peer.Online === true
    })
  }

  return { dnsName: trimDot(self.DNSName), login, peers }
}

/** MagicDNS names are fully qualified and end in a dot. URLs do not. */
function trimDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name
}

/**
 * Whether this install is currently served on the tailnet, and at what origin.
 *
 * Read from `tailscale serve status --json` rather than remembered, because
 * `tailscale serve` is machine state rather than application state: it survives
 * a GitWarren restart, and a user may well turn it off from a terminal. A
 * toggle that showed what this process last did would disagree with the machine
 * and there would be no way for the user to tell which was lying.
 */
export async function tailnetServeOrigin(port: number): Promise<string | null> {
  const output = await tailscale(['serve', 'status', '--json'], STATUS_TIMEOUT_MS)
  if (output === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  const config = parsed as {
    TCP?: Record<string, { HTTP?: boolean; HTTPS?: boolean }>
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  }

  const target = `http://${LINK_SERVER_HOST}:${port}`
  // `Web` is keyed by `<host>:<port>` and holds the handlers under it. The
  // scheme is not in that key, so it comes from `TCP[port]` - which is the one
  // place that says whether the listener terminates TLS.
  for (const [authority, entry] of Object.entries(config.Web ?? {})) {
    const proxies = Object.values(entry.Handlers ?? {}).some(
      (handler) => handler.Proxy !== undefined && handler.Proxy.startsWith(target)
    )
    if (!proxies) continue
    const listenPort = authority.slice(authority.lastIndexOf(':') + 1)
    const scheme = config.TCP?.[listenPort]?.HTTPS === true ? 'https' : 'http'
    return `${scheme}://${authority}`
  }
  return null
}

/**
 * Put the loopback port on the tailnet, and say where it landed.
 *
 * HTTPS first and HTTP as the fallback, in that order, because the outcome is
 * not knowable in advance - see the header. The HTTPS attempt is bounded by a
 * timeout rather than by an error, since a tailnet without certificates
 * enabled leaves `tailscale serve --https` waiting rather than refusing, which
 * M6.0 found the hard way.
 *
 * Answers the origin actually being served, or null if neither worked. Never
 * throws: a settings toggle that failed should say so on the panel, not take a
 * window down.
 */
export async function serveTailnet(port: number): Promise<ServeResult> {
  const target = `http://${LINK_SERVER_HOST}:${port}`

  // `--bg` or the command holds the terminal forever. It is background state on
  // the machine either way, which is why `tailnetServeOrigin` reads it back
  // instead of this function remembering what it did.
  await runTailscale(['serve', '--bg', '--https', String(port), target], SERVE_TIMEOUT_MS)
  const secure = await tailnetServeOrigin(port)
  if (secure !== null) return { origin: secure, failure: '' }

  const plain = await runTailscale(
    ['serve', '--bg', '--http', String(port), target],
    SERVE_TIMEOUT_MS
  )
  const origin = await tailnetServeOrigin(port)
  // The HTTPS attempt's failure is deliberately not reported. On a tailnet
  // without certificates it always fails, and saying so would be telling every
  // user about a thing that is not wrong - see the header. The plain attempt is
  // the one whose refusal means something.
  return { origin, failure: origin === null ? plain.failure : '' }
}

/**
 * What happened when this machine was asked to serve.
 *
 * `origin` is where it landed, or null. `failure` is what `tailscale` said
 * about the refusal, kept verbatim rather than classified: its message names
 * the exact command that would fix the common case, and no paraphrase of ours
 * would be as useful as the sentence its authors wrote.
 */
export interface ServeResult {
  origin: string | null
  failure: string
}

/**
 * Take it off the tailnet.
 *
 * Both spellings, because which one is live depends on what `serveTailnet`
 * managed, and turning off the one that is not running is a no-op rather than
 * an error. Answers whether anything is still served afterwards, so a caller
 * reports the machine's state rather than its own intention.
 */
export async function unserveTailnet(port: number): Promise<boolean> {
  await tailscale(['serve', '--https', String(port), 'off'], SERVE_TIMEOUT_MS)
  await tailscale(['serve', '--http', String(port), 'off'], SERVE_TIMEOUT_MS)
  return (await tailnetServeOrigin(port)) !== null
}
