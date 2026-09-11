/**
 * Who is allowed to be talking to this server at all, before a token is even
 * looked at.
 *
 * Two headers, checked on every request and on every WebSocket upgrade. They
 * guard different attacks and neither one covers for the other.
 *
 * ## `Host`, against DNS rebinding
 *
 * Binding to 127.0.0.1 stops other machines connecting. It does not stop a web
 * page: an attacker's domain can be made to resolve to 127.0.0.1, at which
 * point the browser considers `http://evil.example` and this server the same
 * origin and hands the page everything, cookies included. The one thing the
 * attacker cannot change is the `Host` header the browser sends, which still
 * says `evil.example`. Requiring it to be the loopback authority we hand out is
 * what closes that door - the same check `main/link-server.ts` has made since
 * M2, for the same reason.
 *
 * Only `127.0.0.1:<port>` is accepted, not `localhost:<port>`. `localhost` is
 * not attacker-controllable and would be safe to allow, but it is a *different*
 * origin to a browser: a session cookie set on one is not sent to the other, so
 * accepting both would mean a user who typed the wrong one got an unexplained
 * "no session" page. One authority, named in every URL this app mints.
 *
 * ## The second authority, since M6
 *
 * An install with "Reachable on your tailnet" turned on has exactly one more:
 * its own MagicDNS name and the same port. `tailscale serve` proxies from the
 * tailnet *to loopback*, so such a request arrives on 127.0.0.1 and the only
 * thing distinguishing it is the `Host` header - which is why this is a second
 * accepted value rather than a second listener. Everything above still holds
 * for it: a browser cannot change `Host`, so requiring it to be one of the two
 * we hand out is what forecloses rebinding on both.
 *
 * What is *different* about the tailnet authority is how a request on it is
 * authorised, and that is deliberately not a token. See `isTailnetOwner`.
 *
 * ## `Origin`, against a page that already knows the port
 *
 * A cross-site page cannot read a response it is not allowed to read, but it
 * can *make* the request, and a state-changing one is enough to be worth
 * refusing. `SameSite=Strict` on the session cookie already means such a
 * request arrives without credentials and is refused for that reason; the
 * Origin check is the second lock, and the one that does not depend on a
 * browser's cookie policy being what we think it is.
 *
 * An absent `Origin` is allowed for reads, and that is not a hole. Browsers
 * omit it on top-level navigations - which is precisely how a person arrives
 * here, by clicking a link in a terminal - and send it on every fetch, every
 * form post and every WebSocket upgrade. So "absent" means "not a page acting
 * on its own behalf", and the places where that would matter (writes, the
 * socket) require it to be present and correct.
 */
import { LINK_SERVER_HOST, LINK_SERVER_PORT } from '../../shared/link-port.js'

/** The loopback authority. Until M6 this was the only one. */
export function loopbackAuthority(port: number = LINK_SERVER_PORT): string {
  return `${LINK_SERVER_HOST}:${port}`
}

/**
 * What a tailnet-exposed install answers to, and who it answers for.
 *
 * Null means "not exposed", which is the default and stays the default: a
 * machine with the toggle off has exactly the gate it had in M5.
 *
 * ## Why this is a second authority rather than a second server
 *
 * `tailscale serve` proxies from the tailnet *to loopback*, so a request from
 * a phone arrives on 127.0.0.1 with `Host: pc-wsl.tail688c0c.ts.net:41427`.
 * There is no socket to tell the two apart by - the only difference is the
 * header - which is why this is an addition to the Host check rather than a
 * listener beside it. Measured in M6.0 against the real tailnet.
 */
export interface TailnetGate {
  /** `pc-wsl.tail688c0c.ts.net:41427`, exactly as the proxy will spell `Host`. */
  authority: string
  /** The owner's Tailscale login. Anything else is refused before dispatch. */
  login: string
  /** `http` or `https`, whichever `tailscale serve` managed. See `core/tailnet.ts`. */
  scheme: 'http' | 'https'
}

/**
 * Which authorities this server may be reached at.
 *
 * Both checks exist for the same attack and neither is about tokens - a browser
 * cannot change `Host`, so requiring it to be one we handed out is what
 * forecloses DNS rebinding on either authority.
 */
export function isAllowedHost(
  host: string | undefined,
  port?: number,
  tailnet?: TailnetGate | null
): boolean {
  if (host === loopbackAuthority(port)) return true
  return tailnet !== undefined && tailnet !== null && host === tailnet.authority
}

/** Whether a request arrived at the tailnet authority rather than at loopback. */
export function isTailnetHost(
  host: string | undefined,
  tailnet: TailnetGate | null | undefined
): boolean {
  return tailnet !== undefined && tailnet !== null && host === tailnet.authority
}

/**
 * Whether an `Origin` may act on this server.
 *
 * `required` is what separates a navigation from a fetch: reads that a person
 * can reach by typing a URL tolerate an absent origin, and anything a page
 * could have initiated on its own does not.
 *
 * A page served over the tailnet has the tailnet origin, and it is exactly as
 * entitled as a loopback page: it is the same renderer, served by the same
 * process, to a browser that got through the same gate. What neither may be is
 * *the other one* - a loopback page must not act on the tailnet authority and
 * the reverse - which is what comparing against the two values we mint, rather
 * than parsing, keeps true.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  {
    required,
    port,
    tailnet,
    overTailnet = false
  }: {
    required: boolean
    port?: number
    tailnet?: TailnetGate | null
    /** Whether this request arrived at the tailnet authority. */
    overTailnet?: boolean
  } = { required: false }
): boolean {
  if (origin === undefined || origin === '') return !required
  // Exactly one origin is acceptable, decided by which authority the request
  // arrived at - not "either of the two we mint". That distinction was a
  // comment before it was code, and a test caught the difference: a page on
  // loopback could act on the tailnet authority, because both values were
  // accepted everywhere. Nothing escalated, since both pages are ours, but the
  // shape was wrong and the next authority added would have been wrong the same
  // way. A page acts on the server it was served by.
  //
  // `null` is what a sandboxed iframe or a `data:` document sends. It is an
  // origin, it is not ours, and it is never allowed - which is why this is a
  // string comparison against a value we mint rather than a parse.
  if (overTailnet) {
    return (
      tailnet !== undefined &&
      tailnet !== null &&
      origin === `${tailnet.scheme}://${tailnet.authority}`
    )
  }
  return origin === `http://${loopbackAuthority(port)}`
}

/**
 * The header `tailscale serve` stamps on everything it proxies.
 *
 * Lowercase because Node lowercases header names, and named here because two
 * files read it and one of them is a test that has to forge it.
 */
export const TAILSCALE_USER_HEADER = 'tailscale-user-login'

/**
 * Whether a request that arrived over the tailnet is the owner's.
 *
 * This is the whole of M6's authorisation, and it is a different question from
 * the one `core/web/token.ts` answers - a distinction worth keeping in front of
 * whoever changes this next.
 *
 * The token asks **"was this request made by something the user pointed at
 * GitWarren, or by a page that merely knows the port?"**. That is a question
 * about *intent*, and it is the right one on loopback, where the principal is
 * uninteresting because every process the user runs is already the user.
 *
 * This asks **"is the person at the other end the owner?"**. That is a question
 * about *principal*, and it is the only one available over a network, where
 * intent cannot be checked at all.
 *
 * So a request satisfies one or the other and never both, and in particular a
 * token presented on a tailnet request is ignored rather than honoured: a token
 * minted on the PC is not evidence about the person holding a phone, and
 * treating it as though it were would collapse two mechanisms that are answering
 * different questions. That also leaves `token.ts`'s three properties exactly as
 * they were.
 *
 * ## What this does and does not protect against
 *
 * `tailscaled` sets the header, and it proxies to loopback - so a *local*
 * process could send the header itself with a `Host` naming the tailnet
 * authority and get in without the token. That grants it nothing: a local
 * process running as the user can already read the 0600 token file and open the
 * database directly, which is the principal `token.ts` says loopback has.
 *
 * The door that matters stays shut. A web page cannot set `Host` and cannot set
 * `Tailscale-User-Login` - both are forbidden header names - so the DNS
 * rebinding attack `isAllowedHost` exists for is closed on this authority
 * exactly as it is on the other.
 */
export function isTailnetOwner(
  login: string | string[] | undefined,
  tailnet: TailnetGate | null | undefined
): boolean {
  if (tailnet === undefined || tailnet === null) return false
  // An array means the header arrived twice, which a proxy does not do and this
  // is not the place to guess about. Refused by not being a string.
  if (typeof login !== 'string') return false
  // Tailscale logins are case-insensitive in practice and Tailscale lowercases
  // them; compared as given rather than folded, because the value being
  // compared against came from the same command on the same machine.
  return login === tailnet.login
}
