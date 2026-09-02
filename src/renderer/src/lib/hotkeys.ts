/**
 * One keyboard listener for the whole app.
 *
 * A single listener on `window` rather than a handler per screen, because
 * shortcuts belong to the app and not to whichever element happens to hold
 * focus. React attaches its own events at the root container, so a component
 * that wants a key for itself can still call `stopPropagation` and this will
 * never see it - the escape hatch stays open.
 *
 * Two rules keep the shortcuts out of the way of ordinary use:
 *
 *   - Nothing fires while a text field has focus. Typing "n" into a comment
 *     must not open a dialog, and no amount of cleverness beats simply not
 *     listening. Bindings that carry the command modifier are exempt, since
 *     ⌘K is expected to work from inside a field.
 *   - Nothing fires while a dialog, menu or select is open. Those own the
 *     keyboard until they are dismissed.
 *
 * Chords - `g h`, in the vim tradition - are handled by remembering the first
 * step for a moment. The pending step is returned so the UI can show what it is
 * waiting for, which turns a mystery pause into an obvious one.
 */
import { useEffect, useRef, useState } from 'react'
import { bindingSteps, eventToken } from './keys'

export interface Hotkey {
  /** `mod+k`, `]`, or a chord like `g h`. */
  binding: string
  run: (event: KeyboardEvent) => void
}

/** How long the first step of a chord waits for its second. */
const CHORD_TIMEOUT_MS = 1400

/** Overlays that own the keyboard for as long as they are on screen. */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return (
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
  )
}

/**
 * Install the given shortcuts, and report the half-typed chord.
 *
 * The bindings are read through a ref, so a caller may hand over a freshly
 * built array on every render - which it will, since the commands come from
 * React state - without the listener being torn down and reinstalled each time.
 */
export function useHotkeys(hotkeys: Hotkey[]): string | null {
  const [pending, setPending] = useState<string | null>(null)
  const latest = useRef(hotkeys)

  // Written after each render rather than during one: the listener below only
  // reads it from an event, which is always after the render that set it.
  useEffect(() => {
    latest.current = hotkeys
  })

  useEffect(() => {
    let prefix: string | null = null
    let timer = 0

    function clearPrefix(): void {
      prefix = null
      window.clearTimeout(timer)
      setPending(null)
    }

    function onKeyDown(event: KeyboardEvent): void {
      // Auto-repeat is deliberately allowed through: holding `j` to run down a
      // list is the behaviour people expect from it. `isComposing` is not - a
      // key pressed while an IME is open belongs to the IME.
      if (event.defaultPrevented || event.isComposing) return

      const token = eventToken(event)
      if (token === null) return

      const carriesModifier = token.includes('mod+') || token.includes('meta+')
      if (isTypingTarget(event.target) && !carriesModifier) return
      if (document.querySelector(OVERLAY_SELECTOR) !== null) return

      const candidates = latest.current.map((hotkey) => ({
        hotkey,
        steps: bindingSteps(hotkey.binding)
      }))

      if (prefix !== null) {
        const sequence = `${prefix} ${token}`
        const match = candidates.find(
          (candidate) => candidate.steps.length === 2 && candidate.steps.join(' ') === sequence
        )
        clearPrefix()
        if (match) {
          event.preventDefault()
          match.hotkey.run(event)
        }
        // A first step that led nowhere swallows the second key rather than
        // letting it act on its own: `g` then `x` should do nothing at all,
        // not whatever `x` happens to mean.
        return
      }

      const direct = candidates.find(
        (candidate) => candidate.steps.length === 1 && candidate.steps[0] === token
      )
      if (direct) {
        event.preventDefault()
        direct.hotkey.run(event)
        return
      }

      const startsChord = candidates.some(
        (candidate) => candidate.steps.length > 1 && candidate.steps[0] === token
      )
      if (startsChord) {
        event.preventDefault()
        prefix = token
        setPending(token)
        timer = window.setTimeout(clearPrefix, CHORD_TIMEOUT_MS)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(timer)
    }
    // Installed once for the life of the app. The bindings themselves change
    // constantly - that is what the ref above is for.
  }, [])

  return pending
}
