/**
 * Which words changed between two versions of a line.
 *
 * A diff says *that* a line changed, and for code that is usually enough: the
 * line is short and the eye finds the edit. Prose is the opposite case. A
 * paragraph of Markdown is one line of six hundred characters, and a red copy
 * of it above a green copy of it leaves the reader playing spot-the-difference
 * with a comma. So a removed line and the added line that replaced it are
 * compared word by word, and the words that actually differ are picked out -
 * which is what GitHub does inside a changed line, and what a reviewer of a
 * book chapter needs far more than a reviewer of a function.
 *
 * The same comparison drives the Markdown preview, which marks the changed
 * words inside rendered text rather than inside source - see
 * `features/reviews/markdown-diff.ts`.
 *
 * DOM-free, so it is unit-tested under node.
 */

export interface Range {
  start: number
  end: number
}

export type WordOp = 'equal' | 'delete' | 'insert'

export interface WordChange {
  op: WordOp
  text: string
}

/**
 * Words, runs of whitespace, and single punctuation marks.
 *
 * Punctuation stands alone so that adding a comma marks the comma rather than
 * the whole word it was attached to. Letters are matched as Unicode letters, so
 * a Polish or a German sentence splits into the same kind of words an English
 * one does.
 */
export const PROSE_TOKENS = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu

/**
 * Past this many cells the comparison is not attempted.
 *
 * The middle of two lines - what is left once the shared start and end are
 * trimmed away - is compared with a table of one cell per pair of tokens.
 * Ordinary edits leave a middle of a handful of tokens and cost nothing; two
 * unrelated paragraphs of a thousand words each would cost a million cells per
 * pair, on a screen that may hold dozens of pairs. Lines that different are not
 * worth marking word by word anyway: everything would be marked.
 */
const MAX_CELLS = 250_000

function tokenize(text: string, pattern: RegExp): string[] {
  // A fresh copy each call: a global regex keeps its position between uses.
  return text.match(new RegExp(pattern.source, pattern.flags)) ?? []
}

/**
 * The changes that turn `before` into `after`, word by word.
 *
 * Null when the two are too large and too different to be worth comparing -
 * see `MAX_CELLS`. Consecutive tokens with the same operation are merged, so a
 * caller sees "these four words were removed" and not four separate removals.
 */
export function diffWords(
  before: string,
  after: string,
  pattern: RegExp = PROSE_TOKENS
): WordChange[] | null {
  const left = tokenize(before, pattern)
  const right = tokenize(after, pattern)

  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const a = left.slice(prefix, left.length - suffix)
  const b = right.slice(prefix, right.length - suffix)
  if (a.length * b.length > MAX_CELLS) return null

  const changes: WordChange[] = []
  const push = (op: WordOp, text: string): void => {
    if (text === '') return
    const last = changes[changes.length - 1]
    if (last !== undefined && last.op === op) last.text += text
    else changes.push({ op, text })
  }

  push('equal', left.slice(0, prefix).join(''))

  // Longest common subsequence, filled from the end so the walk below can go
  // forwards and emit the changes in reading order.
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('equal', a[i] ?? '')
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      push('delete', a[i] ?? '')
      i += 1
    } else {
      push('insert', b[j] ?? '')
      j += 1
    }
  }
  for (; i < a.length; i += 1) push('delete', a[i] ?? '')
  for (; j < b.length; j += 1) push('insert', b[j] ?? '')

  push('equal', left.slice(left.length - suffix).join(''))
  return absorbWhitespace(changes)
}

/**
 * Fold a lone space between two edits into the edit.
 *
 * "the quick fox" → "a slow fox" is, token by token, a changed word, an
 * unchanged space, and another changed word - and marking it that way draws two
 * highlighted islands with a gap between them, which reads as two edits when
 * the writer made one. A run of only whitespace sitting between a removal and an
 * insertion on both sides is counted as part of the change instead.
 */
function absorbWhitespace(changes: WordChange[]): WordChange[] {
  const result: WordChange[] = []
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index] as WordChange
    const before = changes[index - 1]
    const after = changes[index + 1]
    const between =
      change.op === 'equal' &&
      /^\s+$/.test(change.text) &&
      before !== undefined &&
      after !== undefined &&
      before.op !== 'equal' &&
      after.op !== 'equal'

    if (!between) {
      result.push({ ...change })
      continue
    }
    // Both sides had the space, so both sides keep it - as part of the edit.
    result.push({ op: 'delete', text: change.text }, { op: 'insert', text: change.text })
  }

  // Re-merge what the split above made adjacent.
  const merged: WordChange[] = []
  for (const change of result) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.op === change.op) last.text += change.text
    else merged.push(change)
  }
  return reorder(merged)
}

/**
 * Removals before insertions within each run of edits, so the two lines can be
 * read off the list in order: the "before" line is every equal and delete, the
 * "after" line every equal and insert.
 */
function reorder(changes: WordChange[]): WordChange[] {
  const result: WordChange[] = []
  let deletes = ''
  let inserts = ''
  const flush = (): void => {
    if (deletes !== '') result.push({ op: 'delete', text: deletes })
    if (inserts !== '') result.push({ op: 'insert', text: inserts })
    deletes = ''
    inserts = ''
  }
  for (const change of changes) {
    if (change.op === 'delete') deletes += change.text
    else if (change.op === 'insert') inserts += change.text
    else {
      flush()
      result.push(change)
    }
  }
  flush()
  return result
}

/**
 * How much of the two lines survived, from 0 (nothing) to 1 (identical).
 *
 * Used to decide whether marking the changed words helps at all. A line that
 * was rewritten from scratch has a few common words by coincidence - "the",
 * a space - and highlighting everything except those is noise, not a diff.
 */
export function similarity(changes: readonly WordChange[]): number {
  let kept = 0
  let before = 0
  let after = 0
  for (const change of changes) {
    if (change.op !== 'insert') before += change.text.length
    if (change.op !== 'delete') after += change.text.length
    // Whitespace that survived is not evidence of anything.
    if (change.op === 'equal') kept += change.text.replace(/\s+/g, '').length
  }
  const longest = Math.max(before, after)
  return longest === 0 ? 1 : kept / longest
}

/** Below this, a pair of lines is treated as a rewrite, not an edit. */
export const MIN_SIMILARITY = 0.35

/**
 * The changed stretches of each line, as character offsets into that line.
 *
 * Null when the lines are too far apart for word marks to mean anything, which
 * a caller treats as "draw the whole line as changed, the way a diff always
 * has".
 */
export function changedRanges(
  before: string,
  after: string
): { removed: Range[]; added: Range[] } | null {
  const changes = diffWords(before, after)
  if (changes === null || similarity(changes) < MIN_SIMILARITY) return null

  const removed: Range[] = []
  const added: Range[] = []
  let left = 0
  let right = 0
  for (const change of changes) {
    const length = change.text.length
    if (change.op === 'delete') {
      removed.push({ start: left, end: left + length })
      left += length
    } else if (change.op === 'insert') {
      added.push({ start: right, end: right + length })
      right += length
    } else {
      left += length
      right += length
    }
  }
  return { removed, added }
}
