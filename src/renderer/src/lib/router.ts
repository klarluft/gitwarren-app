/**
 * Routing, in about eighty lines and no dependency.
 *
 * Three screens do not need a router library, but they do need *some* notion of
 * location: the app now has a back button, and a review's three tabs should be
 * distinguishable. The hash carries it, which means the browser history stack
 * comes along for free - so back/forward work, and a dev-server reload lands on
 * the screen you were looking at instead of dumping you at the top.
 *
 * `useSyncExternalStore` rather than a `useState`/`useEffect` pair: the hash is
 * external state that can change without React's involvement, and this is the
 * hook built for exactly that.
 */
import { useSyncExternalStore } from 'react'

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

const HOME: Route = { name: 'repositories' }

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
    if (Number.isInteger(repositoryId) && repositoryId > 0) return { name: 'repository', repositoryId }
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

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route)
}

/**
 * Replace the current entry instead of adding one. Used for tab switches, so
 * that "back" leaves the review rather than walking through the tabs you
 * happened to open on the way.
 */
export function replace(route: Route): void {
  window.history.replaceState(null, '', hrefFor(route))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function goBack(): void {
  window.history.back()
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => ''
  )
  return parseRoute(hash)
}
