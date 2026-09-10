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

/** The one authority this server answers to. */
export function loopbackAuthority(port: number = LINK_SERVER_PORT): string {
  return `${LINK_SERVER_HOST}:${port}`
}

export function isAllowedHost(host: string | undefined, port?: number): boolean {
  return host === loopbackAuthority(port)
}

/**
 * Whether an `Origin` may act on this server.
 *
 * `required` is what separates a navigation from a fetch: reads that a person
 * can reach by typing a URL tolerate an absent origin, and anything a page
 * could have initiated on its own does not.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  { required, port }: { required: boolean; port?: number } = { required: false }
): boolean {
  if (origin === undefined || origin === '') return !required
  // `null` is what a sandboxed iframe or a `data:` document sends. It is an
  // origin, it is not ours, and it is never allowed - which is why this is a
  // string comparison against the one value we mint rather than a parse.
  return origin === `http://${loopbackAuthority(port)}`
}
