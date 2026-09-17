/**
 * Small view preferences that follow the person, not the data.
 *
 * Whether the file tree is open and which editor to open files in are not
 * facts about a review, so they do not belong in SQLite next to the reviews -
 * and this app has no settings screen to put them on. `localStorage` is the
 * right size of tool: it is per install, it survives a restart, and losing it
 * costs the user one click.
 *
 * Reads and writes are wrapped because storage can be unavailable (a private
 * profile, a locked-down policy), and a preference that cannot be saved should
 * degrade to a default rather than break the screen it was on.
 */
import { useCallback, useState } from 'react'

const PREFIX = 'gitwarren:'

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key)
    else window.localStorage.setItem(PREFIX + key, value)
  } catch {
    // Nothing to do; the value lives for this session only.
  }
}

/** A string preference, remembered across restarts. */
export function useStoredPreference(
  key: string,
  fallback: string | null
): [string | null, (value: string | null) => void] {
  const [value, setValue] = useState<string | null>(() => read(key) ?? fallback)

  const store = useCallback(
    (next: string | null) => {
      setValue(next)
      write(key, next)
    },
    [key]
  )

  return [value, store]
}

/** The same, for a switch. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [stored, store] = useStoredPreference(key, fallback ? 'on' : 'off')
  return [stored === 'on', useCallback((next: boolean) => store(next ? 'on' : 'off'), [store])]
}

/**
 * The same, for a measurement - a column width someone dragged.
 *
 * Null rather than a number is the useful part of the signature: it is the
 * difference between "narrower than the default" and "never touched it", and
 * only the second may be answered by the stylesheet. A sidebar that has not
 * been resized keeps its responsive width and grows with the window; one that
 * has is the width the person chose, on every window they open it in.
 *
 * A stored value that is not a number at all - storage shared with an older
 * build, or edited by hand - reads as null, which lands on the same default.
 */
export function useStoredNumber(
  key: string,
  fallback: number | null
): [number | null, (value: number | null) => void] {
  const [stored, store] = useStoredPreference(key, fallback === null ? null : String(fallback))
  const value = stored === null ? null : Number(stored)

  return [
    // `Number('')` is 0, so "finite" alone would turn a blank entry into a
    // column no pixels wide. Nothing stored here is ever usefully zero.
    value !== null && Number.isFinite(value) && value > 0 ? value : null,
    useCallback((next: number | null) => store(next === null ? null : String(next)), [store])
  ]
}
