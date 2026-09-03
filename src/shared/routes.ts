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

export type Route =
  | { name: 'repositories' }
  | { name: 'repository'; repositoryId: number }
  | { name: 'review'; reviewId: number; tab: ReviewTab; focus?: DiffFocus }

/** The review screen - the only route anything links *into* from outside. */
export type ReviewRoute = Extract<Route, { name: 'review' }>

export const HOME: Route = { name: 'repositories' }

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'repositories':
      return '#/'
    case 'repository':
      return `#/repositories/${route.repositoryId}`
    case 'review': {
      const base = `#/reviews/${route.reviewId}/${route.tab}`
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

export function parseRoute(hash: string): Route {
  const segments = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (segments.length === 0) return HOME

  if (segments[0] === 'repositories' && segments[1]) {
    const repositoryId = Number(segments[1])
    if (Number.isInteger(repositoryId) && repositoryId > 0)
      return { name: 'repository', repositoryId }
  }

  if (segments[0] === 'reviews' && segments[1]) {
    const reviewId = Number(segments[1])
    if (Number.isInteger(reviewId) && reviewId > 0) {
      // An unknown or missing tab falls back rather than 404s - a review is
      // still perfectly viewable without one.
      const tab = isReviewTab(segments[2]) ? segments[2] : 'conversation'
      const focus = parseFocus(segments.slice(3))
      return focus ? { name: 'review', reviewId, tab, focus } : { name: 'review', reviewId, tab }
    }
  }

  return HOME
}
