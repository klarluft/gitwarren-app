/**
 * The element something actually scrolls inside.
 *
 * The app scrolls in a `<main>` that sits below the title bar, not in the
 * window, so a card resting at the top of the page still reports a viewport
 * offset of the title bar's height. Comparing against the scroller's own top
 * edge instead is what makes "which file is at the top" independent of whatever
 * chrome the shell puts above it - and an observer rooted anywhere else would
 * have the scroller clip away everything it was asked to look ahead for.
 */
export function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return document.documentElement
}
