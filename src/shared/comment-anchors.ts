/**
 * Re-finding a comment's line after the branch has moved.
 *
 * A review in GitWarren is two ref *names*, never two pinned shas, so the diff
 * a comment was written against is not the diff the next visitor sees. Insert
 * one line at the top of a file and every line number below it shifts; rewrite
 * the line itself and the comment is about code that no longer exists. GitHub
 * sidesteps this by pinning each comment to the commit it was made on. We
 * cannot, because following the branch is the whole point of the app, so the
 * anchor is re-derived on every read instead.
 *
 * The rule: trust the stored *text* over the stored *line number*. A line
 * number is a position in a document that keeps being rewritten; the text is
 * what the reviewer was actually looking at.
 *
 * This module is deliberately pure and dependency-free. The renderer runs it
 * against the diff it has already fetched, and the MCP server runs it against a
 * diff it reads itself, so both surfaces report the same anchor for the same
 * thread.
 */
import type { DiffLine, FileDiff } from './git.js'

export type DiffSide = 'base' | 'head'

/**
 * Where a thread ended up in the diff being displayed.
 *
 * - `anchored` - the stored line still holds the text it was commented on.
 * - `moved`    - that text is now at a different line; the comment follows it.
 * - `outdated` - the text is not in this diff at all. Either the code changed
 *                under it, or the comment was left on a line the diff never
 *                showed. Both cases mean the same thing to a reader: it cannot
 *                be pinned to a line you can see, so it is listed above the
 *                file rather than inside it.
 */
export type AnchorState = 'anchored' | 'moved' | 'outdated'

export interface ThreadAnchor {
  filePath: string
  side: DiffSide
  line: number
  /** The line's text when the thread was opened; null if it was never captured. */
  anchorText: string | null
}

export interface ResolvedAnchor {
  state: AnchorState
  /** Line on `side` to render against now. Null when outdated. */
  line: number | null
}

const OUTDATED: ResolvedAnchor = { state: 'outdated', line: null }

/** Line numbers live in a different field per side; every read goes through here. */
function numberOn(line: DiffLine, side: DiffSide): number | null {
  return side === 'base' ? line.oldNumber : line.newNumber
}

/**
 * Find the file a thread belongs to.
 *
 * Renames are matched on either name: a thread left on `old/name.ts` before the
 * rename is still about the file now called `new/name.ts`.
 */
export function findAnchorFile(files: FileDiff[], filePath: string): FileDiff | undefined {
  return files.find((file) => file.path === filePath || file.oldPath === filePath)
}

export function resolveAnchor(file: FileDiff | undefined, anchor: ThreadAnchor): ResolvedAnchor {
  if (!file) return OUTDATED

  // Nothing to verify against, so there is no honest way to claim the stored
  // line is still the right one. Report it as outdated rather than guess.
  if (anchor.anchorText === null) return OUTDATED

  // Only lines that exist on the requested side can carry the anchor: an
  // inserted line has no base number, a deleted line has no head number.
  const lines: DiffLine[] = []
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (numberOn(line, anchor.side) !== null) lines.push(line)
    }
  }

  const atStoredLine = lines.find((line) => numberOn(line, anchor.side) === anchor.line)
  if (atStoredLine?.content === anchor.anchorText) {
    return { state: 'anchored', line: anchor.line }
  }

  // With several identical lines - a lone `}` is the common case - the one
  // nearest to where the comment used to be is the best guess available, and a
  // near miss reads far better than dropping the comment out of the file.
  let bestLine: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of lines) {
    if (candidate.content !== anchor.anchorText) continue
    const number = numberOn(candidate, anchor.side)
    if (number === null) continue
    const distance = Math.abs(number - anchor.line)
    if (distance < bestDistance) {
      bestLine = number
      bestDistance = distance
    }
  }

  if (bestLine === null) return OUTDATED
  return { state: 'moved', line: bestLine }
}

/** True for a thread that is about a line rather than about the review overall. */
export function isInlineAnchor(thread: {
  filePath: string | null
  side: DiffSide | null
  line: number | null
}): thread is { filePath: string; side: DiffSide; line: number } {
  return thread.filePath !== null && thread.side !== null && thread.line !== null
}
