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

export const REVIEW_TABS = ['conversation', 'commits', 'files'] as const
export type ReviewTab = (typeof REVIEW_TABS)[number]

/**
 * A line of the diff to scroll to and mark on arrival.
 *
 * In the hash rather than in a module variable so that the jump from a
 * conversation thread to its code is a *location*: it survives a reload, it can
 * be gone back to, and the files tab does not have to be told about it by
 * whoever happened to render it.
 */
export interface DiffFocus {
  filePath: string
  side: 'base' | 'head'
  /** Line on that side, already resolved against the diff being shown. */
  line: number
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
  | ({ name: 'repository'; repositoryId: number } & HostScoped)
  | ({ name: 'review'; reviewId: number; tab: ReviewTab; focus?: DiffFocus } & HostScoped)

/** The review screen - the only route anything links *into* from outside. */
export type ReviewRoute = Extract<Route, { name: 'review' }>

export const HOME: Route = { name: 'repositories' }

/** The segment that introduces a host. Short because it prefixes every link. */
const HOST_SEGMENT = 'h'

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
    case 'repository':
      return `#/${prefix}repositories/${route.repositoryId}`
    case 'review': {
      const base = `#/${prefix}reviews/${route.reviewId}/${route.tab}`
      if (!route.focus) return base
      // The path is encoded whole, slashes included, so it stays one segment.
      const { filePath, side, line } = route.focus
      return `${base}/${encodeURIComponent(filePath)}/${side}/${line}`
    }
  }
}

function isReviewTab(value: string | undefined): value is ReviewTab {
  return REVIEW_TABS.includes(value as ReviewTab)
}

/** `<encoded path>/<side>/<line>`, or nothing if any of it is missing or wrong. */
function parseFocus(segments: string[]): DiffFocus | undefined {
  const [encoded, side, rawLine] = segments
  if (!encoded || (side !== 'base' && side !== 'head')) return undefined

  const line = Number(rawLine)
  if (!Number.isInteger(line) || line <= 0) return undefined

  try {
    return { filePath: decodeURIComponent(encoded), side, line }
  } catch {
    // A hand-mangled hash with a stray `%`. Losing the focus is the right
    // failure - the tab itself is still perfectly openable.
    return undefined
  }
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
