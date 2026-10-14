/**
 * Find out, once, when an element first comes near the visible part of its
 * scroller.
 *
 * This is what lets a four-hundred-file diff open in the time a ten-file one
 * does: a card draws its header straight away and its body only when the reader
 * is about to reach it. "Near" is a screenful and a half either side, so the
 * body is built while it is still out of sight and scrolling never lands on a
 * blank one.
 *
 * One observer per scroller rather than one per element. A diff that needs this
 * at all has hundreds of cards, and the browser answers for all of them in a
 * single pass when they share an observer.
 *
 * The root has to be the scroller and not the window. An observer rooted at the
 * window still sees through the scroller's clipping, so anything scrolled out
 * of `<main>` would never count as near however wide the margin was drawn.
 */
import { scrollParent } from './scroll-parent'

/** How far beyond the visible part of the scroller counts as near. */
const LOOKAHEAD = '150% 0px'

interface Watch {
  observer: IntersectionObserver
  callbacks: Map<Element, () => void>
}

const watches = new Map<HTMLElement, Watch>()

function watchFor(root: HTMLElement): Watch {
  const existing = watches.get(root)
  if (existing) return existing

  const callbacks = new Map<Element, () => void>()
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const callback = callbacks.get(entry.target)
        if (callback === undefined) continue
        forget(root, entry.target)
        callback()
      }
    },
    {
      // The document's own scroller is the implicit root; naming it explicitly
      // makes the margin apply to an element rather than to the viewport.
      root: root === document.documentElement ? null : root,
      rootMargin: LOOKAHEAD
    }
  )

  const watch = { observer, callbacks }
  watches.set(root, watch)
  return watch
}

function forget(root: HTMLElement, element: Element): void {
  const watch = watches.get(root)
  if (watch === undefined) return
  watch.observer.unobserve(element)
  watch.callbacks.delete(element)
  // A scroller that leaves the page takes its observer with it.
  if (watch.callbacks.size === 0) {
    watch.observer.disconnect()
    watches.delete(root)
  }
}

/** Call `onNear` the first time `element` is near view. Returns a cancel. */
export function whenNearViewport(element: HTMLElement, onNear: () => void): () => void {
  const root = scrollParent(element)
  const watch = watchFor(root)
  watch.callbacks.set(element, onNear)
  watch.observer.observe(element)
  return () => forget(root, element)
}
