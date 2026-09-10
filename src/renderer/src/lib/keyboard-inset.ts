/**
 * Keeping what you are typing into above the on-screen keyboard.
 *
 * The app scrolls inside `<main>`, not inside the window - which is right for a
 * desktop window and is exactly what makes a phone keyboard awkward. When the
 * keyboard opens, the *visual* viewport shrinks but the layout viewport does
 * not, so the browser's own "scroll the focused element into view" has only a
 * pan to offer, and a pan cannot move content inside a scroller it does not
 * know about. The composer keeps its place on a page that is no longer visible.
 *
 * Half the fix is a line of HTML: `interactive-widget=resizes-content` in the
 * web shell's viewport meta makes the keyboard shrink the *layout* viewport
 * instead, so the whole `height: 100%` chain - shell, `<main>`, scroller -
 * comes down with it and there is somewhere to scroll to. See
 * `src/web/index.html`.
 *
 * This is the other half. Once the scroller has been resized, something has to
 * scroll it, and the browser only does that reliably for the focused element
 * itself - which here is the textarea, not the buttons under it. Landing with
 * the caret visible and `Comment` still under the keyboard is the failure worth
 * avoiding: it reads as a composer that cannot be submitted. So the element
 * brought into view is the composer as a whole, aligned to the bottom of the
 * scrollport.
 *
 * Nothing here runs in the Electron window, where `visualViewport` never
 * resizes because no keyboard ever covers anything.
 */
import { useEffect, type RefObject } from 'react'

export function useKeepAboveKeyboard(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (viewport === null || viewport === undefined) return

    let frame = 0

    const reveal = (): void => {
      const element = ref.current
      if (element === null) return
      // Only when the focus is inside this composer. A visual viewport resizes
      // for a rotation, a pinch and a desktop window drag as well, and a page
      // that scrolls itself on any of those is a page that fights the reader.
      if (!element.contains(document.activeElement)) return

      // One frame later: the resize arrives while the viewport is still
      // animating open, and a scroll computed against a half-height viewport
      // lands short.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        element.scrollIntoView({ block: 'end', behavior: 'smooth' })
      })
    }

    // Both, and for different moments. The resize is the keyboard opening onto
    // a composer already focused; the focus is moving from one composer to
    // another while it is already open, which resizes nothing.
    viewport.addEventListener('resize', reveal)
    document.addEventListener('focusin', reveal)

    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', reveal)
      document.removeEventListener('focusin', reveal)
    }
  }, [ref])
}
