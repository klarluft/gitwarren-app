/**
 * Whether the window is too narrow to put two things side by side.
 *
 * Almost all of the responsive pass is CSS, and CSS is where it belongs: a
 * breakpoint that only changes how something looks needs no state and no
 * re-render. This hook is for the one case that is not a matter of looks - the
 * files tab, where a narrow window does not shrink the file tree beside the
 * diff but replaces it, and *picking a file has to navigate back*. A behaviour
 * that differs by width has to be a value the component can branch on.
 *
 * The breakpoint is Tailwind's `lg` (64rem) said in JavaScript, because the
 * same number decides the CSS on either side of it and two spellings of one
 * breakpoint drift. Below it the diff has under about 700px once the tree has
 * taken its 224, and a diff that narrow is a column of single characters.
 *
 * `useSyncExternalStore` rather than an effect and a piece of state: the store
 * form reads the current match during render, so the first paint is already
 * right. An effect would paint the wide layout once and then correct it, which
 * on a phone is a visible flash of the very layout this exists to avoid.
 */
import { useCallback, useSyncExternalStore } from 'react'

/** Tailwind's `lg`. Keep in step with the `lg:` prefixes in the files tab. */
const WIDE = '(min-width: 64rem)'

export function useNarrow(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(WIDE)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return useSyncExternalStore(
    subscribe,
    () => !window.matchMedia(WIDE).matches,
    // Server snapshot: nothing renders this outside a browser today, and wide
    // is the answer that matches the desktop window the app usually is.
    () => false
  )
}
