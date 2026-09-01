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
