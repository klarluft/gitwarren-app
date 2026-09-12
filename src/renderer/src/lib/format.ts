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

const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })

/**
 * "14:32", for something that happened while the window was open.
 *
 * A clock time rather than `relativeTime`, and the difference matters for the
 * one caller: the disconnection banner says when what is on screen was loaded,
 * and it is only redrawn when the machine's state changes. A relative phrase
 * would freeze at "just now" and stay there for the rest of the outage, while
 * a clock time is as true an hour later as it was at the time.
 */
export function timeOfDay(timestamp: number): string {
  return CLOCK.format(timestamp)
}

/**
 * "412 KB". Powers of two with the units people expect next to a file, which
 * is what every git host prints beside an image.
 *
 * The guard on the first line is about where the number comes from. A size is
 * whatever the store reported, and a file that vanished between the listing and
 * the stat hands back `undefined` through a type that promised a number - which
 * arrives here as `NaN` and leaves as the string "NaN B", printed in the corner
 * of an image the user is looking at. An em dash is the honest thing to draw
 * when nobody knows the size, and putting it here rather than a `?? ''` at each
 * of the three call sites means the next caller inherits the answer.
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const COUNT = new Intl.NumberFormat()

/**
 * "3 files" / "1 file" - pluralisation is not worth a dependency.
 *
 * The count goes through `Intl` for the same reason the timestamps above do: a
 * review that refreshes a vendored lockfile really does say 24000 files, and an
 * unseparated run of digits is a number the reader has to stop and count. The
 * locale is the one the window is already formatting its dates in, so the
 * separator matches the rest of the screen rather than being chosen here.
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${COUNT.format(count)} ${count === 1 ? singular : pluralForm}`
}
