/**
 * Turning a loopback link's fragment into a location this app understands.
 *
 * An agent hands out `http://127.0.0.1:41427/#h=<instance>/review/4/files/…`.
 * That fragment is the *deep link* grammar - what the "Open in GitWarren" page
 * pastes `gitwarren://` onto - and it is not the app's hash grammar, which says
 * `#/reviews/4/files`. In the Electron shell the translation happens in
 * `main/deep-link.ts`, on a string the window never sees. In a browser the URL
 * is already in the address bar, so it happens on the way in.
 *
 * Kept apart from `bootstrap.ts` because it is the only part of that file with
 * no DOM in it, and therefore the only part that can be tested the way
 * everything else here is tested - as a node program. The rules it encodes are
 * the ones `localise` states in `main/deep-link.ts`, and they have to stay
 * identical in both shells:
 *
 *  - a fragment that is not a loopback fragment is left alone, which is every
 *    navigation after the first;
 *  - the fragment is *parsed* to a `Route` and written back out from that, so
 *    nothing an outside party wrote is ever assigned to `location.hash`;
 *  - this install's own id is dropped, so the router is handed the route it
 *    would have been handed anyway;
 *  - another install's id keeps its host segment, so the link opens *that*
 *    machine's review 4 and never this one's.
 */
// Relative rather than through the `@shared` alias, unlike its neighbours in
// this directory. They are only ever built by Vite; this one is also *run* by
// the test runner, which is a node program with no bundler in front of it and
// no alias to resolve. The other tested renderer modules get away with `@shared`
// because they import nothing but types, which are erased before anything has
// to be found on disk.
import { LOOPBACK_HOST_PREFIX, parseDeepLink } from '../shared/deep-link.js'
import { HOME, type Route } from '../shared/routes.js'

/** Whether a hash is one of the links an agent hands out. */
export function isLoopbackFragment(hash: string): boolean {
  return hash.replace(/^#/, '').startsWith(LOOPBACK_HOST_PREFIX)
}

/**
 * The route a loopback fragment means on the install whose id is `instanceId`.
 *
 * Null when the hash is not a loopback fragment at all - the caller should
 * leave the location exactly as it found it, rather than rewrite it to
 * something equivalent.
 */
export function routeForLoopbackFragment(hash: string, instanceId: string): Route | null {
  const fragment = hash.replace(/^#/, '')
  if (!fragment.startsWith(LOOPBACK_HOST_PREFIX)) return null

  const route = parseDeepLink(`gitwarren://${fragment.slice(LOOPBACK_HOST_PREFIX.length)}`)
  // Addressed to us and malformed inside: the app opens on something harmless
  // rather than swallowing the click.
  if (!route) return HOME
  if (route.host === undefined) return route

  if (route.host === instanceId) {
    // Rebuilt without the key rather than set to undefined - `hrefFor` and
    // route equality both read the presence of the property, not its value.
    const { host: _host, ...local } = route
    return local
  }

  /**
   * Another install's review, opened where it was clicked.
   *
   * Until M6 this landed on the home screen, and the comment said "reviews on
   * other hosts arrive in M4" - which they did, three milestones ago, while
   * this line went on discarding them. M4.3, M4.4 and M5.3 each noticed and
   * each deferred it, reasonably: nothing in those milestones produced a link
   * that named another machine, because a link is minted by the install that
   * owns the review and until the tailnet there was no ordinary way for one to
   * travel.
   *
   * The route is handed over *with* its host segment, which is the whole of the
   * change and is also what preserves the rule this line was written for. The
   * thing that must never happen is opening our own review 4 because the link
   * said 4 - ids are per host, so that would show the wrong review with no sign
   * of it. Keeping the segment makes that structurally impossible: the route
   * says whose review it is, and `core/hosts/router.ts` sends the reads to that
   * machine or fails naming it.
   *
   * No check that the host is *known*, deliberately. This runs before the app
   * has asked the core anything, and the question is asynchronous; more to the
   * point, "that machine is not in your list" is a sentence
   * `requireInstance` already writes, naming the id - which is the only thing a
   * person can compare against their Hosts screen. Guessing here would replace
   * a specific answer with a shrug.
   */
  return route
}
