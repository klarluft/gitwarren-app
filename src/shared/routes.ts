/**
 * The app's locations, as data.
 *
 * This is the hash grammar the renderer's router has always used, lifted out of
 * it so that the main process and the MCP server can speak it too. A deep link
 * arriving from the OS has to be turned into one of these before anything acts
 * on it, and the MCP server has to be able to write one down; neither of them
 * can import `lib/router.ts`, which is React and DOM all the way through.
 *
 * Nothing here touches a global. It is compiled for the renderer *and* for the
 * node-side processes, so it may use only what both of them have.
 */
import { isInstanceId } from './instance-id.js'

export const REVIEW_TABS = ['conversation', 'commits', 'files', 'browse'] as const
export type ReviewTab = (typeof REVIEW_TABS)[number]

/**
 * Where in a tab full of code the reader is being sent.
 *
 * In the hash rather than in a module variable so that the jump from a
 * conversation thread to its code is a *location*: it survives a reload, it can
 * be gone back to, and the tab does not have to be told about it by whoever
 * happened to render it.
 *
 * The line is optional, and that is what the browse tab writes: "open
 * `src/app.ts`" is a perfectly good destination on a screen that shows one file
 * at a time, and `#/reviews/4/browse/src%2Fapp.ts` is how a person would expect
 * to be able to say it. A path without a line already had a meaning in Files
 * changed too - scroll to that file's card - which is exactly what arriving
 * with a line the diff does not contain has always fallen back to.
 *
 * `side` travels with the line rather than on its own. On its own it would be
 * an assertion about a file with no line to make it about, and the two are
 * written and read as one pair everywhere they appear.
 */
export interface DiffFocus {
  filePath: string
  side?: 'base' | 'head'
  /** Line on that side, already resolved against the code being shown. */
  line?: number
}

/**
 * Which install a location is on.
 *
 * Every route may name a host, and every route omits it when the location is on
 * the GitWarren doing the reading. That asymmetry is deliberate and is what
 * keeps this change invisible: a link written before hosts existed, or written
 * today for a local review, is byte-for-byte the link it always was.
 *
 * The value is an instance id (`core/instance.ts`), not a hostname. Machines
 * are renamed, move between networks and are reached over four different
 * carriers; the id is the one name that survives all of it, and it is what the
 * `hosts` table will resolve to a way of connecting.
 *
 * Ids stay per-host autoincrement integers rather than becoming globally unique
 * - a review is "4 on host X" everywhere, in routes, links and cache keys - so
 * a review id without a host is meaningless anywhere but locally. That is
 * precisely why the segment goes in now, before any link that needs it exists.
 */
export interface HostScoped {
  /** Instance id of the install this location is on. Absent means the local one. */
  host?: string
}

export type Route =
  | ({ name: 'repositories' } & HostScoped)
  | ({ name: 'agent' } & HostScoped)
  /**
   * The list of other machines. Deliberately *not* `HostScoped`.
   *
   * Every other location here can be on another install, because a repository,
   * a review and an agent prompt all belong to a machine. A host list does not:
   * it is the property of the install a person is driving, `hosts.*` is
   * answered locally and never forwarded, and `isLocalOnly` in
   * `core/hosts/ssh.ts` enforces that at the carrier. `#/h/<id>/hosts` would be
   * a URL for a screen that cannot exist, so the type says it cannot be
   * written.
   *
   * `host?: undefined` rather than leaving the property off: everything that
   * handles a `Route` generically - the deep-link guard, the loopback
   * translation - asks whether it is on this install, and a member with no such
   * property at all would make that question a type error at four call sites
   * that are all perfectly happy with the answer "no host". Declaring it as
   * always-undefined says the same thing to a reader and to the compiler.
   */
  | { name: 'hosts'; host?: undefined }
  | ({ name: 'repository'; repositoryId: number } & HostScoped)
  | ({ name: 'review'; reviewId: number; tab: ReviewTab; focus?: DiffFocus } & HostScoped)

/** The review screen - the only route anything links *into* from outside. */
export type ReviewRoute = Extract<Route, { name: 'review' }>

export const HOME: Route = { name: 'repositories' }

/** The segment that introduces a host. Short because it prefixes every link. */
const HOST_SEGMENT = 'h'

/**
 * The Agent Access page.
 *
 * A location rather than a disclosure on the home screen, because from M3 there
 * are two shells and from M4 there is one of these per host: `#/h/<id>/agent` is
 * how you say "the setup instructions for *that* machine", and there has to be
 * a way to say it before there is a second machine to say it about. It is also
 * the one screen whose whole purpose is to be sent to someone - or opened in a
 * browser next to the agent being configured - and a URL is how that is done.
 */
const AGENT_SEGMENT = 'agent'

/** The Hosts screen. Never preceded by a host segment - see `Route`. */
const HOSTS_SEGMENT = 'hosts'

/**
 * `#/h/<instance>`, or nothing at all for a local route.
 *
 * The empty string in the local case is what makes the grammar backwards
 * compatible: `hrefFor` builds the same strings it always did unless someone
 * has explicitly asked for a location on another install.
 */
function hostPrefix(route: HostScoped): string {
  return route.host === undefined ? '' : `${HOST_SEGMENT}/${route.host}/`
}

export function hrefFor(route: Route): string {
  const prefix = hostPrefix(route)
  switch (route.name) {
    case 'repositories':
      return `#/${prefix}`
    case 'agent':
      return `#/${prefix}${AGENT_SEGMENT}`
    // No prefix, and not because one was forgotten: see `Route`.
    case 'hosts':
      return `#/${HOSTS_SEGMENT}`
    case 'repository':
      return `#/${prefix}repositories/${route.repositoryId}`
    case 'review': {
      const base = `#/${prefix}reviews/${route.reviewId}/${route.tab}`
      if (!route.focus) return base
      // The path is encoded whole, slashes included, so it stays one segment.
      const { filePath, side, line } = route.focus
      const at = side === undefined || line === undefined ? '' : `/${side}/${line}`
      return `${base}/${encodeURIComponent(filePath)}${at}`
    }
  }
}

function isReviewTab(value: string | undefined): value is ReviewTab {
  return REVIEW_TABS.includes(value as ReviewTab)
}

/**
 * Is this a path inside the repository, as a link is allowed to name one?
 *
 * The same rule as `isSafeRelativePath` in `core/git-compare.ts`, applied a
 * long way earlier. That one is the real defence - it guards the actual file
 * read, and it is the one that must never be removed - but a hash is hostile
 * input that can arrive from a deep link an agent wrote into a comment, and
 * this parser's standing promise is that it never produces a location the app
 * could not already express. `../../etc/passwd` is not one of those, so it does
 * not become a `Route` in the first place.
 *
 * Checked here rather than left to the reader because since the browse tab a
 * focus path is not only a scroll target: it is the file the screen goes and
 * asks for.
 */
function isLinkablePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(path)) return false
  return !path.split(/[\\/]/).includes('..')
}

/**
 * `<encoded path>`, or `<encoded path>/<side>/<line>`.
 *
 * All or nothing, and deliberately so. A bare path is a complete destination -
 * the browse tab's "open this file", and in Files changed the scroll-to-card
 * that arriving with an unfindable line has always fallen back to. But segments
 * that are *present and wrong* - `a.ts/sideways/9`, `a.ts/head/oops` - mean the
 * link was built by something that got the grammar wrong, and the honest
 * response to half a location is none of it. The tab itself is still perfectly
 * openable, which is where such a link lands.
 */
function parseFocus(segments: string[]): DiffFocus | undefined {
  const [encoded, side, rawLine] = segments
  if (!encoded) return undefined

  let filePath: string
  try {
    filePath = decodeURIComponent(encoded)
  } catch {
    // A hand-mangled hash with a stray `%`.
    return undefined
  }

  if (!isLinkablePath(filePath)) return undefined

  // Nothing after the path: the file is the destination.
  if (side === undefined && rawLine === undefined) return { filePath }

  if (side !== 'base' && side !== 'head') return undefined

  const line = Number(rawLine)
  if (!Number.isInteger(line) || line <= 0) return undefined

  return { filePath, side, line }
}

/**
 * Take a leading `h/<instance>` off the front, if there is one.
 *
 * A host segment that is not an instance id is not a host segment. Rejecting it
 * rather than passing the string through is the same rule the rest of this
 * parser follows: a hash is hostile input - it can arrive from a deep link an
 * agent wrote into a comment - and nothing here may produce a location the app
 * cannot already express. An unrecognised prefix simply is not stripped, and
 * the route falls through to the home screen below.
 */
function takeHost(segments: string[]): { host?: string; rest: string[] } {
  if (segments[0] !== HOST_SEGMENT) return { rest: segments }
  const candidate = segments[1]
  if (candidate === undefined || !isInstanceId(candidate)) return { rest: segments }
  return { host: candidate, rest: segments.slice(2) }
}

export function parseRoute(hash: string): Route {
  const all = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const { host, rest: segments } = takeHost(all)

  // Spread rather than assign, so a local route has no `host` key at all rather
  // than one set to undefined. The difference is invisible to a reader and very
  // visible to anything comparing two routes for equality.
  const scope = host === undefined ? {} : { host }

  // A host with nothing after it is that host's repository list, which is a
  // real location and the right place for a truncated link to land.
  if (segments.length === 0) return host === undefined ? HOME : { name: 'repositories', host }

  if (segments[0] === AGENT_SEGMENT) return { name: 'agent', ...scope }

  // Read *before* the host is honoured rather than after, so that a link
  // someone assembled by hand as `#/h/<id>/hosts` lands on this machine's host
  // list instead of silently falling through to another machine's repositories.
  // There is one host list and it is this one; the segment says so either way.
  if (segments[0] === HOSTS_SEGMENT) return { name: 'hosts' }

  if (segments[0] === 'repositories' && segments[1]) {
    const repositoryId = Number(segments[1])
    if (Number.isInteger(repositoryId) && repositoryId > 0)
      return { name: 'repository', repositoryId, ...scope }
  }

  if (segments[0] === 'reviews' && segments[1]) {
    const reviewId = Number(segments[1])
    if (Number.isInteger(reviewId) && reviewId > 0) {
      // An unknown or missing tab falls back rather than 404s - a review is
      // still perfectly viewable without one.
      const tab = isReviewTab(segments[2]) ? segments[2] : 'conversation'
      const focus = parseFocus(segments.slice(3))
      return focus
        ? { name: 'review', reviewId, tab, focus, ...scope }
        : { name: 'review', reviewId, tab, ...scope }
    }
  }

  // Unrecognised, but the host - if there was a valid one - is still known, and
  // dropping it would send the user to the wrong machine's home screen.
  return host === undefined ? HOME : { name: 'repositories', host }
}
