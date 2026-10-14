/**
 * Scroll to an element that may not exist yet.
 *
 * Jumping to a file from the command palette usually means changing tab first,
 * so the target is still being rendered when the jump is asked for. Retrying
 * across a handful of frames covers that without anyone having to coordinate:
 * whoever wants the scroll asks for it, and it happens as soon as the thing to
 * scroll to appears.
 *
 * A target that never turns up is silence rather than an error - the file left
 * the diff, and there is nothing useful to say about it mid-jump.
 */

import { scrollParent } from './scroll-parent'

/** Half a second at 60Hz: long enough for a tab switch, short enough to drop. */
const MAX_FRAMES = 30

/**
 * How many screens away a target may be and still be scrolled to smoothly.
 * See `scrollToElement`.
 */
const SMOOTH_WITHIN_SCREENS = 3

/**
 * `scrollIntoView`, except that a smooth scroll to something far away is made
 * instant.
 *
 * Two reasons, and the second is the one that matters. An animation across a
 * hundred screens of diff is a blur that tells the reader nothing about where
 * they went. And a long diff builds each file's rows as it comes near the
 * screen - see `lib/near-viewport.ts` - so a smooth scroll from the top to the
 * last file builds every file in between, which on a four-hundred-file branch
 * is the whole two million elements the lazy build exists to avoid.
 */
export function scrollToElement(element: HTMLElement, options: ScrollIntoViewOptions): void {
  if (options.behavior === 'smooth') {
    const scroller = scrollParent(element)
    const top = scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top
    const distance = Math.abs(element.getBoundingClientRect().top - top)
    if (distance > scroller.clientHeight * SMOOTH_WITHIN_SCREENS) {
      element.scrollIntoView({ ...options, behavior: 'instant' })
      return
    }
  }
  element.scrollIntoView(options)
}

export function revealElement(
  id: string,
  options: ScrollIntoViewOptions = { block: 'start', behavior: 'smooth' }
): () => void {
  let frames = 0
  let frame = 0

  const attempt = (): void => {
    const element = document.getElementById(id)
    if (element) {
      scrollToElement(element, options)
      return
    }
    frames += 1
    if (frames < MAX_FRAMES) frame = requestAnimationFrame(attempt)
  }

  frame = requestAnimationFrame(attempt)
  return () => cancelAnimationFrame(frame)
}
