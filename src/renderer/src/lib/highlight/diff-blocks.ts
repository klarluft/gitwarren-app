/**
 * What to tokenize for a diff, and how to find a row's colours afterwards.
 *
 * A diff is not a file, and a grammar fed the rows in order would be reading a
 * program nobody wrote: an added line and the line it replaced, one after the
 * other, both opening the same string. So each hunk is read as the two
 * documents it is a window onto. The head side is the context and added lines
 * in order - a real, contiguous stretch of the new file - and the base side is
 * the context and removed lines, the same stretch of the old one. A row is then
 * coloured from the side it belongs to: added and context rows from the head,
 * removed rows from the base, which is how GitHub does it.
 *
 * Hunks are separate blocks rather than one long document because what lies
 * between two hunks is unknown, and carrying grammar state across a gap would
 * colour the second hunk according to a guess. The cost is the rare hunk that
 * starts inside a block comment; once the whole file has been read (to unfold
 * context, or to browse it) the head side is coloured from the whole file
 * instead and that goes away too.
 *
 * DOM-free, so it is unit-tested under node.
 */
import type { DiffLine } from '@shared/git'
import type { LineTokens } from './tokenize'

export interface DiffBlocks {
  /** Two per hunk, head then base, ready to hand to the tokenizer. */
  blocks: string[][]
  /** Line numbers matching each block's lines, in the same order. */
  numbers: number[][]
}

/**
 * Lay a diff's hunks out for the tokenizer. Anything with lines will do - a
 * comment's snippet is a piece of one hunk and is laid out the same way.
 */
export function diffBlocks(hunks: readonly { lines: readonly DiffLine[] }[]): DiffBlocks {
  const blocks: string[][] = []
  const numbers: number[][] = []

  for (const hunk of hunks) {
    const head: string[] = []
    const headNumbers: number[] = []
    const base: string[] = []
    const baseNumbers: number[] = []

    for (const line of hunk.lines) {
      if (line.type !== 'delete' && line.newNumber !== null) {
        head.push(line.content)
        headNumbers.push(line.newNumber)
      }
      if (line.type !== 'insert' && line.oldNumber !== null) {
        base.push(line.content)
        baseNumbers.push(line.oldNumber)
      }
    }

    blocks.push(head, base)
    numbers.push(headNumbers, baseNumbers)
  }

  return { blocks, numbers }
}

/**
 * Finds the colours for one row of a diff, or null while there are none yet.
 *
 * A view that has a highlighter at all is showing code in a language it can
 * colour, and draws added and removed lines in the plain foreground - the
 * tint on the row says which they are - rather than in green and red, which
 * would fight the syntax colours. It does that from the first frame, before
 * the tokens arrive, so the text goes from plain to coloured and never from
 * green to plain to coloured.
 */
export type LineHighlighter = (line: DiffLine) => LineTokens | null

/**
 * Index tokenized diff blocks by line number, side by side.
 *
 * `file` is the whole head-side file, tokenized as one block, when it has been
 * read. It wins for every head-side row whose text still matches the file -
 * which is the check that keeps an out-of-date read from colouring a line with
 * another line's tokens.
 */
export function diffHighlighter(
  layout: DiffBlocks,
  tokens: LineTokens[][] | null,
  file: { lines: readonly string[]; tokens: LineTokens[] } | null
): LineHighlighter {
  const head = new Map<number, LineTokens>()
  const base = new Map<number, LineTokens>()

  if (tokens !== null) {
    for (const [index, block] of tokens.entries()) {
      const target = index % 2 === 0 ? head : base
      const numbers = layout.numbers[index] ?? []
      for (const [position, lineTokens] of block.entries()) {
        const number = numbers[position]
        if (number !== undefined) target.set(number, lineTokens)
      }
    }
  }

  return (line) => {
    if (line.type === 'delete') {
      return line.oldNumber === null ? null : (base.get(line.oldNumber) ?? null)
    }
    if (line.newNumber === null) return null
    if (file !== null && file.lines[line.newNumber - 1] === line.content) {
      return file.tokens[line.newNumber - 1] ?? null
    }
    return head.get(line.newNumber) ?? null
  }
}
