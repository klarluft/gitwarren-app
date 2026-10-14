/**
 * The arithmetic behind the review progress strip, kept apart from the DOM so
 * it can be tested on its own.
 *
 * Everything here counts in *files*, never in lines. A branch that touches four
 * source files and regenerates a lock file is five files of work, not one lock
 * file with some code attached: reading past the lock file is one step of five,
 * however many thousand lines it scrolls.
 */

/**
 * How far below the top of the scroller a file card may still sit and count as
 * the one being read.
 *
 * Shared by stepping with `[` and `]` and by the progress strip, so the strip
 * never names a different file from the one the next key press leaves.
 *
 * Larger than it looks like it needs to be, deliberately. `scrollIntoView` does
 * not land exactly on zero - measured, it settles several pixels short - and the
 * cards are separated by a gap of their own. A threshold tighter than that error
 * makes a stepped-to file read as "not reached yet", so the next press aims at
 * the same file again and stepping appears to stick. It only has to stay far
 * below the height of any card to be unambiguous, and it does.
 */
export const TOP_EDGE_SLACK = 24

export type FileMark = 'reviewed' | 'changed' | 'unread'

/** A stretch of neighbouring files in the same state, in file units. */
export interface MarkRun {
  mark: Exclude<FileMark, 'unread'>
  start: number
  length: number
}

/**
 * The reviewed and changed-since files as runs.
 *
 * Drawn as one element per run rather than one per file, so a thousand-file
 * branch that has been read straight through is a single bar and not a
 * thousand slivers. Unread files are the track itself and need no element.
 */
export function markRuns(
  paths: readonly string[],
  reviewed: ReadonlySet<string>,
  changed: ReadonlySet<string>
): MarkRun[] {
  const runs: MarkRun[] = []
  for (const [index, path] of paths.entries()) {
    const mark: FileMark = reviewed.has(path)
      ? 'reviewed'
      : changed.has(path)
        ? 'changed'
        : 'unread'
    if (mark === 'unread') continue
    const last = runs.at(-1)
    if (last !== undefined && last.mark === mark && last.start + last.length === index) {
      last.length += 1
    } else {
      runs.push({ mark, start: index, length: 1 })
    }
  }
  return runs
}

/** Where a file's card sits, measured in the same coordinates as the line. */
export interface CardBox {
  top: number
  height: number
}

/**
 * How far down the list of files the reader is, from 0 to `count`.
 *
 * The whole part is the file whose card is under the reading line - where a
 * card stepped to comes to rest, give or take `TOP_EDGE_SLACK` - and the fraction is
 * how much of that card has gone past it. So the marker moves through a short
 * file quickly and a long one slowly, but every file is the same width on the
 * strip, and finishing a file always moves it on by exactly one slot.
 *
 * Cards are in document order, so the one under the line is found by binary
 * search: a handful of layout reads per scroll frame, however long the diff.
 * `boxOf` returns null for a card that is not in the DOM; it is treated as
 * still below the line.
 */
export function readingPosition(
  count: number,
  line: number,
  boxOf: (index: number) => CardBox | null,
  atEnd: boolean
): number {
  if (count === 0) return 0
  // A scroller that cannot go any further has shown the reader everything,
  // including a last file too short ever to reach the top.
  if (atEnd) return count

  let low = 0
  let high = count - 1
  let found = -1
  let foundBox: CardBox | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    const box = boxOf(middle)
    if (box !== null && box.top <= line) {
      found = middle
      foundBox = box
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (found === -1 || foundBox === null) return 0
  const through = foundBox.height <= 0 ? 1 : (line - foundBox.top) / foundBox.height
  return found + Math.min(1, Math.max(0, through))
}

/** Which file a point along the strip is over, given its width. */
export function fileAt(count: number, offset: number, width: number): number {
  if (count === 0 || width <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.floor((offset / width) * count)))
}
