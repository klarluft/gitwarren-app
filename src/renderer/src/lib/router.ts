/**
 * Routing, in about forty lines and no dependency.
 *
 * Three screens do not need a router library, but they do need *some* notion of
 * location: the app has a back button, and a review's three tabs should be
 * distinguishable. The hash carries it, which means the browser history stack
 * comes along for free - so back/forward work, and a dev-server reload lands on
 * the screen you were looking at instead of dumping you at the top.
 *
 * The grammar itself lives in `@shared/routes`, because the main process needs
 * to speak it too: a `gitwarren://` deep link is parsed to a `Route` there
 * before it is allowed anywhere near this window. What is left here is the part
 * that needs a DOM - reading the hash, writing it, and subscribing to it.
 *
 * `useSyncExternalStore` rather than a `useState`/`useEffect` pair: the hash is
 * external state that can change without React's involvement, and this is the
 * hook built for exactly that.
 */
import { useSyncExternalStore } from 'react'
import { hrefFor, parseRoute, type Route } from '@shared/routes'

export { hrefFor, parseRoute, REVIEW_TABS } from '@shared/routes'
export type { DiffFocus, ReviewTab, Route } from '@shared/routes'

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
