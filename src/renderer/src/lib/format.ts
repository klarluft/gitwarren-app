/**
 * Small display helpers.
 *
 * `Intl` does the work rather than a date library - the app already ships a
 * whole browser, and this is the entire formatting surface.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000]
]

/** "3 days ago". Falls back to the raw value if it is not a usable date. */
export function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return iso

  const elapsed = timestamp - Date.now()
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) return RELATIVE.format(Math.round(elapsed / size), unit)
  }
  return 'just now'
}

/** The full timestamp, for a `title` attribute next to a relative one. */
export function absoluteTime(iso: string | null): string {
  if (!iso) return ''
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? iso : ABSOLUTE.format(timestamp)
}

/** "3 files" / "1 file" - pluralisation is not worth a dependency. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
