/**
 * A "back to top" button for the app's one scrolling element.
 *
 * The whole app scrolls inside `<main>` rather than the window, so this takes
 * that element rather than reaching for `window.scrollTo` - which would do
 * nothing at all here.
 *
 * `useSyncExternalStore` rather than a scroll handler writing to `useState`:
 * the scroll offset is external state that changes without React's
 * involvement, the snapshot is a boolean so React re-renders only when the
 * button actually appears or disappears, and it keeps a `setState` out of an
 * effect body. Same hook, same reason, as the hash router.
 */
import { useSyncExternalStore, type RefObject } from 'react'
import { ArrowUp } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * How far down the button waits before appearing. About a screen: any less and
 * it is in the way on pages that barely scroll.
 */
const SHOW_AFTER_PX = 600

/**
 * Past this, the trip is animated away rather than scrolled. Smooth-scrolling
 * the length of a large diff takes seconds and reads as the app hanging; the
 * animation only helps when it is short enough to follow.
 */
const SMOOTH_LIMIT_PX = 5_000

/**
 * Scroll events do not bubble, but they do reach the window in the capture
 * phase - so one listener there sees every scroller in the app without needing
 * the element in hand when it subscribes. Passive, because this never calls
 * `preventDefault` and saying so keeps it off the critical path of the scroll.
 */
function subscribeToScrolling(onChange: () => void): () => void {
  window.addEventListener('scroll', onChange, { capture: true, passive: true })
  return () => window.removeEventListener('scroll', onChange, { capture: true })
}

function useScrolledPast(target: RefObject<HTMLElement | null>, threshold: number): boolean {
  // The snapshot is a boolean, so the horizontal scrollers inside the diff wake
  // this up but cannot re-render it: React bails out when the value is equal.
  return useSyncExternalStore(
    subscribeToScrolling,
    () => (target.current?.scrollTop ?? 0) > threshold,
    () => false
  )
}

export function ScrollToTop({ target }: { target: RefObject<HTMLElement | null> }) {
  const visible = useScrolledPast(target, SHOW_AFTER_PX)

  // Not rendered at all rather than hidden: a button nobody can see should not
  // be in the tab order either.
  if (!visible) return null

  function toTop(): void {
    const element = target.current
    if (!element) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollTo({
      top: 0,
      behavior: reduced || element.scrollTop > SMOOTH_LIMIT_PX ? 'auto' : 'smooth'
    })
    // Return the keyboard to the top of the document as well, so the next Tab
    // continues from where the eye now is instead of from far down the page.
    element.focus({ preventScroll: true })
  }

  return (
    <Tooltip label="Back to top" side="left">
      <button
        type="button"
        onClick={toTop}
        aria-label="Back to top"
        className={cn(
          // Below dialogs and popups (z-50), above the page.
          'fixed bottom-6 right-6 z-30 flex size-10 items-center justify-center rounded-full',
          'border border-border bg-card text-muted-foreground shadow-lg',
          'transition-colors hover:bg-muted hover:text-foreground',
          'motion-safe:animate-[rise-in_120ms_ease-out]'
        )}
      >
        <ArrowUp className="size-5" />
      </button>
    </Tooltip>
  )
}
