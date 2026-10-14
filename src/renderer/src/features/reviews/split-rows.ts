/**
 * A hunk laid out side by side, and the changed words inside its changed lines.
 *
 * The unified diff is one column: context, then everything removed, then
 * everything added, and the reader reassembles "this became that" in their
 * head. Side by side does the reassembling for them. Each run of removals is
 * set against the run of additions that follows it, row for row, so the old
 * version of a paragraph sits level with the new one - which, for a long line
 * of prose, is the difference between reading a diff and decoding one.
 *
 * Pairing is positional within a run, which is what GitHub does and what
 * matches how edits are actually made: rewrite three lines and you get three
 * removals followed by three additions in the same order. When the counts
 * differ the longer side carries on with an empty cell opposite.
 *
 * DOM-free, so it is unit-tested under node.
 */
import { changedRanges, type Range } from '../../lib/word-diff'
import type { DiffLine } from '@shared/git'

export interface SplitRow {
  /** The base side: a removal or context. Null where the head side added a line. */
  left: DiffLine | null
  /** The head side: an addition or context. Null where the base side lost a line. */
  right: DiffLine | null
}

/** Each removal with the addition opposite it, in the order they appear. */
export function pairChanges(lines: readonly DiffLine[]): Array<[DiffLine | null, DiffLine | null]> {
  const pairs: Array<[DiffLine | null, DiffLine | null]> = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] as DiffLine
    if (line.type === 'context') {
      pairs.push([line, line])
      index += 1
      continue
    }

    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (lines[index]?.type === 'delete') removed.push(lines[index++] as DiffLine)
    while (lines[index]?.type === 'insert') added.push(lines[index++] as DiffLine)
    // An addition that came first - git does not emit that order, but a run of
    // insertions with no removals before it is ordinary - is still collected
    // above, with nothing on the left.
    for (let row = 0; row < Math.max(removed.length, added.length); row += 1) {
      pairs.push([removed[row] ?? null, added[row] ?? null])
    }
  }
  return pairs
}

export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  return pairChanges(lines).map(([left, right]) => ({ left, right }))
}

/**
 * The words that changed inside every line that has a counterpart.
 *
 * Keyed by the line object itself, which is stable for as long as the diff it
 * came from is - one computation per diff, read by whichever rows are drawn.
 * A line with no entry is drawn whole, as a diff always drew it: it either has
 * nothing opposite it, or what is opposite it is a rewrite rather than an edit.
 */
export function wordChangesFor(
  hunks: readonly { lines: readonly DiffLine[] }[]
): ReadonlyMap<DiffLine, Range[]> {
  const changes = new Map<DiffLine, Range[]>()
  for (const hunk of hunks) {
    for (const [left, right] of pairChanges(hunk.lines)) {
      if (left === null || right === null || left === right) continue
      const ranges = changedRanges(left.content, right.content)
      if (ranges === null) continue
      changes.set(left, ranges.removed)
      changes.set(right, ranges.added)
    }
  }
  return changes
}
