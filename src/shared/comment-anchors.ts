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
 * ## Two things a comment can be anchored in
 *
 * A diff, which is what this module did when the only readable thing in a
 * review was its patch - and a *file*, since a comment may now be left on a
 * file the branch never touched. The rule above is the same for both, and so is
 * every case that makes it interesting (the text moved, the text is gone, the
 * text appears five times), so the search is written once over a list of
 * numbered lines and the two entry points differ only in where they get that
 * list. A diff contributes the lines its hunks happen to print; a file
 * contributes all of them.
 *
 * That equivalence is load-bearing rather than tidy. A comment on an unchanged
 * file resolved by a diff-only rule would be `outdated` from the moment it was
 * written - not because anything drifted, but because the reader was asking the
 * wrong document.
 *
 * This module is deliberately pure and dependency-free. The renderer runs it
 * against the diff or file it has already fetched, and the MCP server runs it
 * against ones it reads itself, so both surfaces report the same anchor for the
 * same thread.
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
  /**
   * The last line of the comment's range, and the one the text anchor is for.
   * A single-line comment is a range of one.
   */
  line: number
  /** First line of the range; null (or equal to `line`) for a single line. */
  startLine?: number | null
  /** The line's text when the thread was opened; null if it was never captured. */
  anchorText: string | null
}

export interface ResolvedAnchor {
  state: AnchorState
  /** Line on `side` to render against now. Null when outdated. */
  line: number | null
  /**
   * First line of the range, moved by the same amount as `line`.
   *
   * Only the last line is re-found by its text; the rest of the range follows
   * it by keeping the span the same length. Re-finding both ends independently
   * would let a range silently grow or invert when one of them matched
   * somewhere unhelpful, and a comment that claims to cover code it was never
   * about is worse than one that is a line off.
   */
  startLine: number | null
}

const OUTDATED: ResolvedAnchor = { state: 'outdated', line: null, startLine: null }

/** Line numbers live in a different field per side; every read goes through here. */
function numberOn(line: DiffLine, side: DiffSide): number | null {
  return side === 'base' ? line.oldNumber : line.newNumber
}

/**
 * One line of whatever document the comment is being re-found in.
 *
 * The smallest thing the search below actually needs, which is why it is this
 * and not `DiffLine`: a file has no sides and no insert/delete, and asking it
 * to pretend otherwise would mean inventing an `oldNumber` for every line of
 * every unchanged file just to throw it away one function later.
 */
interface NumberedLine {
  number: number
  content: string
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

/**
 * The search itself: the stored line if it still reads the same, else the
 * nearest line that does, else nothing.
 *
 * Both entry points below come through here, so "how a comment follows its
 * code" is one piece of behaviour with one set of tests rather than two
 * implementations that agree until someone touches one of them.
 */
function resolveIn(lines: NumberedLine[], anchor: ThreadAnchor): ResolvedAnchor {
  // Nothing to verify against, so there is no honest way to claim the stored
  // line is still the right one. Report it as outdated rather than guess.
  if (anchor.anchorText === null) return OUTDATED

  /** Keep the range the length it was written at; see `ResolvedAnchor`. */
  const span = Math.max(anchor.line - (anchor.startLine ?? anchor.line), 0)
  const withRange = (state: AnchorState, line: number): ResolvedAnchor => ({
    state,
    line,
    startLine: span === 0 ? null : Math.max(line - span, 1)
  })

  const atStoredLine = lines.find((line) => line.number === anchor.line)
  if (atStoredLine?.content === anchor.anchorText) {
    return withRange('anchored', anchor.line)
  }

  // With several identical lines - a lone `}` is the common case - the one
  // nearest to where the comment used to be is the best guess available, and a
  // near miss reads far better than dropping the comment out of the file.
  let bestLine: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of lines) {
    if (candidate.content !== anchor.anchorText) continue
    const distance = Math.abs(candidate.number - anchor.line)
    if (distance < bestDistance) {
      bestLine = candidate.number
      bestDistance = distance
    }
  }

  if (bestLine === null) return OUTDATED
  return withRange('moved', bestLine)
}

export function resolveAnchor(file: FileDiff | undefined, anchor: ThreadAnchor): ResolvedAnchor {
  if (!file) return OUTDATED

  // Only lines that exist on the requested side can carry the anchor: an
  // inserted line has no base number, a deleted line has no head number.
  const lines: NumberedLine[] = []
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const number = numberOn(line, anchor.side)
      if (number !== null) lines.push({ number, content: line.content })
    }
  }

  return resolveIn(lines, anchor)
}

/**
 * The same question asked of a file's own text, for a comment on a file the
 * diff does not contain.
 *
 * `lines` is the file as `FileContent` carries it: index 0 is line 1, which is
 * the one place in this module where that conversion happens.
 *
 * Head side only, and that is not a limitation so much as what the words mean.
 * "Base" and "head" are ends of a *comparison*; a file nobody changed has one
 * version, and it is the one on screen. A base-side anchor arriving here is a
 * thread about a line the change removed, which by definition is a line this
 * file does not have - so it is outdated, and saying so is more honest than
 * matching its text against the current file and claiming a hit.
 */
export function resolveAnchorInFile(
  lines: string[] | undefined,
  anchor: ThreadAnchor
): ResolvedAnchor {
  if (lines === undefined || anchor.side === 'base') return OUTDATED
  return resolveIn(
    lines.map((content, index) => ({ number: index + 1, content })),
    anchor
  )
}

/** True for a thread that is about a line rather than about the review overall. */
export function isInlineAnchor(thread: {
  filePath: string | null
  side: DiffSide | null
  line: number | null
}): thread is { filePath: string; side: DiffSide; line: number } {
  return thread.filePath !== null && thread.side !== null && thread.line !== null
}
