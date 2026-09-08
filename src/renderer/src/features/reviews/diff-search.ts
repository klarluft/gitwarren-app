/**
 * Finding text inside the diff that is on screen.
 *
 * Kept apart from the rendering for two reasons. The tab needs the hits in
 * order - to count them, and to walk them with the keyboard - while each row
 * needs only its own, and a row that decided for itself where the highlights go
 * could disagree with the counter above it. Both ask `matchOffsets`, so they
 * cannot.
 *
 * The search runs over the patch: the lines git produced for this comparison.
 * Context a reviewer has unfolded is highlighted like anything else, because
 * text that is plainly on screen and not marked reads as a broken search - but
 * it is not counted and Enter does not stop on it. What "12 matches" means then
 * stays a fact about the diff rather than about which gaps happen to be open.
 *
 * DOM-free on purpose, like `lib/keys`: it is the part worth testing, and the
 * tests here are node programs.
 */
import type { DiffSide } from '@shared/comment-anchors'
import type { DiffLine, FileDiff } from '@shared/git'

/** One hit, addressed the way the diff addresses a row. */
export interface DiffMatch {
  filePath: string
  side: DiffSide
  line: number
  /** Which hit within that row, so a line holding the query twice can be walked. */
  occurrence: number
}

export interface DiffMatches {
  matches: DiffMatch[]
  /** Files holding at least one hit. */
  fileCount: number
  /** True when the ceiling below was reached and there are more hits than these. */
  truncated: boolean
}

/**
 * What a file card needs in order to draw the search that is running.
 *
 * Declared here rather than beside the card's other props because it is shared
 * by the three parties - the bar that owns the query, the card, and the row -
 * and this is the module none of them can avoid importing.
 */
export interface DiffSearch {
  /** The text being looked for. Never empty when a search is on. */
  query: string
  /** The current hit, when it is in this file. */
  active: { side: DiffSide; line: number; occurrence: number } | null
}

/**
 * As many hits as are worth collecting.
 *
 * A one-letter query against a large diff matches tens of thousands of times,
 * and neither the counter nor anyone pressing Enter has a use for the tail of
 * that. Stopping keeps typing responsive and is reported rather than hidden.
 */
export const MAX_MATCHES = 1000

/**
 * Which side of the diff a row belongs to, and its number on that side.
 *
 * Head where the line still exists, base for a line the change deleted - the
 * same choice GitHub makes, and the only one that lets a reviewer remark on
 * removed code at all. The renderer reads it from here too, so a hit and the
 * row it is meant to land on can never be addressed differently.
 */
export function rowPosition(line: DiffLine): { side: DiffSide; number: number | null } {
  return line.newNumber !== null
    ? { side: 'head', number: line.newNumber }
    : { side: 'base', number: line.oldNumber }
}

/**
 * Where `query` occurs in `content`, case-insensitively, without overlaps.
 *
 * Case folding is done on a copy and only trusted while it leaves the length
 * alone. A handful of characters grow when lowercased - `İ` becomes two code
 * units - and an offset measured against the folded string would then slice the
 * original in the wrong place, mangling the line it was supposed to mark. Those
 * rare lines fall back to an exact search, which is right more often than a
 * shifted highlight is.
 */
export function matchOffsets(content: string, query: string): number[] {
  if (query === '' || content === '') return []

  const folded = content.toLowerCase()
  const aligned = folded.length === content.length
  const haystack = aligned ? folded : content
  const needle = aligned ? query.toLowerCase() : query
  if (needle === '') return []

  const offsets: number[] = []
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    offsets.push(at)
  }
  return offsets
}

/** Every hit in the diff, in reading order: file by file, top to bottom. */
export function findDiffMatches(
  files: readonly FileDiff[],
  query: string,
  limit: number = MAX_MATCHES
): DiffMatches {
  if (query === '') return { matches: [], fileCount: 0, truncated: false }

  const matches: DiffMatch[] = []
  let fileCount = 0

  for (const file of files) {
    let counted = false

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const { side, number } = rowPosition(line)
        // A row with no number on either side is not a row anything can be
        // scrolled to, so it is not a place a hit can be reported.
        if (number === null) continue

        const offsets = matchOffsets(line.content, query)
        // Counted as soon as the file is known to hold something, so the tally
        // is right even when the ceiling below stops the walk mid-file.
        if (offsets.length > 0 && !counted) {
          counted = true
          fileCount += 1
        }

        for (let occurrence = 0; occurrence < offsets.length; occurrence += 1) {
          if (matches.length >= limit) return { matches, fileCount, truncated: true }
          matches.push({ filePath: file.path, side, line: number, occurrence })
        }
      }
    }
  }

  return { matches, fileCount, truncated: false }
}
