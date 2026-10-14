/**
 * Light, dark, or whatever the machine is set to.
 *
 * Following the OS stays the default, and it is still the right one: the app
 * then matches the rest of the desktop without anyone configuring anything.
 * The override is for the times that is not what you want - a dark desktop and
 * a review you would rather read on white, or the other way round at night.
 *
 * The choice is a view preference, so it lives where the others do (see
 * `preferences.ts`): in `localStorage`, per install and per browser, never in
 * the database. A phone and a laptop pointed at the same daemon can disagree,
 * and should be allowed to.
 *
 * This module owns the `.dark` class on `<html>`. Everything else reads that
 * class rather than asking here - the stylesheet through its tokens, the code
 * highlighter through a MutationObserver - so whoever decided the scheme, the
 * whole window agrees about it.
 */
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

const KEY = 'gitwarren:theme'

const SYSTEM_DARK = '(prefers-color-scheme: dark)'

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

function readStored(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(KEY)
    // Anything unrecognised - an older build, a hand edit - is "follow the OS",
    // which is what the app did before there was a choice at all.
    return isPreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

let preference: ThemePreference = 'system'
const listeners = new Set<() => void>()

/**
 * Put the class where the preference says, without animating the change.
 *
 * Buttons and rows carry `transition-colors` for their hover states, and every
 * one of them would otherwise fade to the new palette at its own pace - a
 * ripple across the window rather than a switch. Transitions are off for the
 * one frame the class changes in, and back on once it has been painted.
 */
function apply(): void {
  const root = document.documentElement
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia(SYSTEM_DARK).matches)
  if (root.classList.contains('dark') === dark) return

  root.classList.add('theme-switching')
  root.classList.toggle('dark', dark)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove('theme-switching'))
  )
}

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Apply the stored preference and keep it applied. Called once, before the
 * first paint, from `main.tsx`.
 */
export function startTheme(): void {
  preference = readStored()
  apply()

  // The OS switching only matters while following it, and `apply` is a no-op
  // when the class is already right, so this need not ask which case it is in.
  window.matchMedia(SYSTEM_DARK).addEventListener('change', apply)

  // Another window or tab of the same install changed it. `storage` only fires
  // in the documents that did *not* make the change, which is exactly the set
  // that needs telling.
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return
    preference = isPreference(event.newValue) ? event.newValue : 'system'
    apply()
    notify()
  })
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  try {
    // "system" is stored as nothing, so an install that never touched the
    // switch and one that went back to the default look the same on disk.
    if (next === 'system') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, next)
  } catch {
    // Unsaveable: the choice holds until the window closes, then the OS wins.
  }
  apply()
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference)
}
