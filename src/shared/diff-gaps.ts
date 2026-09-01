/**
 * The lines a unified diff does *not* show.
 *
 * `git diff -U3` prints three lines of context around each change, so a file
 * arrives as islands of hunks separated by stretches nobody can see. GitHub
 * lets you unfold those stretches; this module works out where they are.
 *
 * Everything is expressed in **head-side line numbers**, because that is the
 * side the expanded text is read from. A gap's `delta` converts back to the
 * base side: `oldNumber = newNumber - delta`. Inside a gap every line is
 * unchanged context by definition - that is what makes the conversion a single
 * constant, and what makes expanding a diff sound at all.
 *
 * Pure and dependency-free so it can be unit-tested without a repository.
 */
import type { DiffHunk } from './git.js'

export interface DiffGap {
  /** First head-side line the diff does not show. */
  start: number
  /** Last hidden line, or null for the tail, which ends where the file does. */
  end: number | null
  /** `oldNumber = newNumber - delta` for every line in this gap. */
  delta: number
  /**
   * Index of the hunk this gap sits above; `hunks.length` for the tail. Gaps of
   * zero length are not returned at all, so this is how a renderer pairs the
   * two lists back up.
   */
  beforeHunk: number
}

export interface GapSegment {
  kind: 'hidden' | 'revealed'
  start: number
  end: number
}

/**
 * The gaps between a file's hunks, in file order.
 *
 * `includeTail` adds the open-ended run after the last hunk. It is the caller's
 * decision because only the caller knows whether a tail is possible: a file the
 * diff shows in full - a new file, an untracked one - has nothing after its
 * last hunk, and offering to unfold nothing is worse than not offering.
 */
/**
 * The first line a hunk actually shows on a side.
 *
 * An empty range is written `@@ -a,0 ...`, where `a` is the line the missing
 * content *followed* rather than the line it starts at - so a pure-deletion
 * hunk claims one line more than it should unless the start is nudged past it.
 * Getting this wrong shifts every unfolded line in the file by one, which is
 * the sort of wrong that looks right.
 */
function effectiveStart(start: number, lines: number): number {
  return lines === 0 ? start + 1 : start
}

/** The last line a hunk shows, or the line before it when it shows none. */
function effectiveEnd(start: number, lines: number): number {
  return effectiveStart(start, lines) + lines - 1
}

/**
 * True when a hunk carries straight on from what is printed above it - the
 * previous hunk, or the beginning of the file for the first one.
 *
 * This is what decides whether a `@@` header has anything to announce. A hunk
 * that starts at line 1, which is every new file and every deleted one, has no
 * break above it, and a divider drawn there is describing a discontinuity that
 * does not exist.
 */
export function continuesFromAbove(hunks: DiffHunk[], index: number): boolean {
  const hunk = hunks[index]
  if (hunk === undefined) return false

  const previous = index === 0 ? undefined : hunks[index - 1]
  const previousEnd =
    previous === undefined ? 0 : effectiveEnd(previous.newStart, previous.newLines)

  return effectiveStart(hunk.newStart, hunk.newLines) <= previousEnd + 1
}

export function fileGaps(hunks: DiffHunk[], options: { includeTail: boolean }): DiffGap[] {
  const gaps: DiffGap[] = []
  /** First head-side line no hunk or gap has accounted for yet. */
  let next = 1
  let trailingDelta = 0

  for (const [index, hunk] of hunks.entries()) {
    const oldStart = effectiveStart(hunk.oldStart, hunk.oldLines)
    const newStart = effectiveStart(hunk.newStart, hunk.newLines)

    if (newStart - 1 >= next) {
      // Both ends of a gap are unchanged context, so the offset the following
      // hunk begins with is the offset that holds across the whole gap.
      gaps.push({ start: next, end: newStart - 1, delta: newStart - oldStart, beforeHunk: index })
    }

    next = Math.max(next, newStart + hunk.newLines)
    trailingDelta = newStart + hunk.newLines - (oldStart + hunk.oldLines)
  }

  if (options.includeTail) {
    gaps.push({ start: next, end: null, delta: trailingDelta, beforeHunk: hunks.length })
  }

  return gaps
}

/** How many lines a gap hides, given where the file ends. */
export function gapLength(gap: DiffGap, totalLines: number | null): number | null {
  const end = gap.end ?? totalLines
  if (end === null) return null
  return Math.max(end - gap.start + 1, 0)
}

/**
 * Split a gap into the runs that are on screen and the runs that are still
 * folded, so each folded run can carry its own expander.
 *
 * `totalLines` closes an open-ended tail; until the file has been read the tail
 * has no known end and cannot be segmented, so callers get an empty list and
 * show a single expander instead.
 */
export function segmentGap(
  gap: DiffGap,
  revealed: ReadonlySet<number>,
  totalLines: number | null
): GapSegment[] {
  const end = gap.end === null ? totalLines : Math.min(gap.end, totalLines ?? gap.end)
  if (end === null || end < gap.start) return []

  // The common case by far, and worth not walking a ten-thousand-line gap for.
  if (revealed.size === 0) return [{ kind: 'hidden', start: gap.start, end }]

  const segments: GapSegment[] = []
  for (let line = gap.start; line <= end; line += 1) {
    const kind = revealed.has(line) ? 'revealed' : 'hidden'
    const last = segments[segments.length - 1]
    if (last && last.kind === kind && last.end === line - 1) last.end = line
    else segments.push({ kind, start: line, end: line })
  }
  return segments
}
