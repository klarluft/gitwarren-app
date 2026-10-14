/**
 * Two versions of a Markdown document, compared the way a reader sees them.
 *
 * The line diff is the right tool for code and the wrong one for a chapter. A
 * writer who rephrases one sentence changes one line - which is the whole
 * paragraph - and the reviewer gets the paragraph twice, raw, in red and green,
 * with the syntax still in it. What they wanted to see was the paragraph, as it
 * reads, with the sentence that changed picked out.
 *
 * So this compares *blocks* - paragraphs, headings, list items, quotes, code
 * fences - the units a reader actually reads, and inside a block that was
 * edited rather than replaced it compares words. The rendered preview in
 * `markdown-preview.tsx` draws the result; nothing here touches the DOM, so it
 * is unit-tested under node.
 *
 * ## Where the old version comes from
 *
 * There is no "read the base side of a file" call, and none is needed. The
 * diff's hunks are every difference between the two versions, and the head
 * version is read whole for the expanders anyway - so the base is rebuilt by
 * walking the head text and putting the hunks back the other way. That costs no
 * new round trip and, more to the point, cannot disagree with the diff on
 * screen: it *is* that diff, applied in reverse. A file the diff could not show
 * in full cannot be rebuilt, and says so.
 *
 * ## How changes are marked inside rendered text
 *
 * The changed words are wrapped in private-use characters in the *source*,
 * before it is parsed - see `SENTINELS` - and turned into `<ins>`/`<del>`
 * elements after, by `remarkChangeMarks`. Marking the source rather than the
 * rendered output is what lets a changed word inside `**bold**` text or a list
 * item come out bold and in a list, marked. The tokenizer keeps links, images
 * and inline code whole, so a mark never lands inside their syntax; and a block
 * whose *structure* changed - a paragraph that became a heading, a table, a code
 * fence - is not merged at all, but shown as the old block and the new one.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { diffWords, MIN_SIMILARITY, similarity, type WordChange } from '../../lib/word-diff'
import type { DiffLine, FileDiff } from '@shared/git'

/**
 * Rebuild the base version of a file from its head version and its diff.
 *
 * `headLines` is the whole head file, as `reviews.file` read it with the same
 * `changes` the diff was read with. Null when the base cannot be known: the
 * diff was clipped, or the head text does not line up with the hunks - a file
 * that changed on disk between the two reads, say. Showing a preview built on
 * a guess would be worse than showing none.
 */
export function rebuildBase(file: FileDiff, headLines: readonly string[] | null): string[] | null {
  if (file.truncated) return null
  // A new file has no base; an untracked one is new by definition.
  if (file.status === 'added' || file.isUntracked) return []
  // A deleted file's patch is the whole of it, removed.
  if (file.status === 'deleted') {
    return file.hunks.flatMap((hunk) =>
      hunk.lines.filter((line) => line.type !== 'insert').map((line) => line.content)
    )
  }
  if (headLines === null) return null

  const base: string[] = []
  // The next head line not yet accounted for, 1-based.
  let cursor = 1
  for (const hunk of file.hunks) {
    // A hunk that adds nothing names the line it follows rather than the one it
    // starts on - that is how git writes `+12,0`.
    const before = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
    for (; cursor <= before; cursor += 1) {
      const line = headLines[cursor - 1]
      if (line === undefined) return null
      base.push(line)
    }
    for (const line of hunk.lines) {
      if (line.type === 'insert') {
        cursor += 1
        continue
      }
      if (line.type === 'context') {
        if (headLines[cursor - 1] !== line.content) return null
        cursor += 1
      }
      base.push(line.content)
    }
  }
  for (; cursor <= headLines.length; cursor += 1) base.push(headLines[cursor - 1] as string)
  return base
}

/** The head version straight from the patch, for a file the patch holds whole. */
export function headFromPatch(file: FileDiff): string[] | null {
  if (file.truncated) return null
  if (file.status === 'deleted') return []
  if (file.status !== 'added' && !file.isUntracked) return null
  return file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line: DiffLine) => line.type !== 'delete').map((line) => line.content)
  )
}

export type BlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'listItem'
  | 'blockquote'
  | 'code'
  | 'table'
  | 'html'
  | 'thematicBreak'
  | 'definition'
  | 'other'

/** One readable unit of a document, and where it sits in the file. */
export interface MarkdownBlock {
  kind: BlockKind
  /** First and last line, 1-based and inclusive - what a comment is anchored to. */
  start: number
  end: number
  /** The block's source, exactly as written. */
  text: string
}

/**
 * Cut a document into blocks.
 *
 * Parsed rather than split on blank lines, because Markdown's blocks are not
 * where the blank lines are: a fenced code block may contain blank lines, a list
 * item may be one line among many with none between them, and a heading needs
 * no blank line after it at all. A list is cut into its items, because an item
 * is what a writer adds or rewrites - a list compared as one block would mark
 * all twenty items as changed for the sake of one.
 *
 * Front matter is taken off the top by hand first: it is not Markdown, and the
 * parser would read its fences as a rule and a heading.
 */
export function markdownBlocks(lines: readonly string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  let offset = 0

  if (lines[0] === '---') {
    const close = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'))
    if (close > 0) {
      blocks.push({
        kind: 'frontmatter',
        start: 1,
        end: close + 1,
        text: lines.slice(0, close + 1).join('\n')
      })
      offset = close + 1
    }
  }

  const body = lines.slice(offset)
  const tree = fromMarkdown(body.join('\n'))
  const slice = (start: number, end: number): string => body.slice(start - 1, end).join('\n')
  const add = (kind: BlockKind, node: { position?: { start: { line: number }; end: { line: number } } }): void => {
    if (node.position === undefined) return
    const { start, end } = node.position
    blocks.push({
      kind,
      start: start.line + offset,
      end: end.line + offset,
      text: slice(start.line, end.line)
    })
  }

  for (const node of tree.children) {
    if (node.type === 'list') {
      for (const item of node.children) add('listItem', item)
      continue
    }
    if (node.type === 'paragraph') {
      // Without the GFM extension a table parses as a paragraph of pipes. It is
      // still one block; it only needs to be known as a table so it is never
      // merged word by word - a mark inside its pipes would break the table.
      add(/^\s*\|/.test(slice(node.position?.start.line ?? 1, node.position?.start.line ?? 1)) ? 'table' : 'paragraph', node)
      continue
    }
    const kind: BlockKind =
      node.type === 'heading' ||
      node.type === 'blockquote' ||
      node.type === 'code' ||
      node.type === 'html' ||
      node.type === 'thematicBreak' ||
      node.type === 'definition'
        ? node.type
        : 'other'
    add(kind, node)
  }
  return blocks
}

/**
 * Link reference definitions - `[home]: https://…` - from anywhere in the file.
 *
 * Each block is rendered on its own, which would cut a reference-style link off
 * from the definition it points at three pages down. The definitions are added
 * to every block's source when it is rendered; they draw nothing themselves.
 */
export function definitionsOf(blocks: readonly MarkdownBlock[]): string {
  return blocks
    .filter((block) => block.kind === 'definition')
    .map((block) => block.text)
    .join('\n')
}

/** One row of the comparison, in reading order. */
export type PreviewRow =
  | { kind: 'same'; before: MarkdownBlock; after: MarkdownBlock }
  | { kind: 'removed'; before: MarkdownBlock }
  | { kind: 'added'; after: MarkdownBlock }
  /** Edited in place: the words that changed are known. */
  | { kind: 'changed'; before: MarkdownBlock; after: MarkdownBlock; words: WordChange[] }

/** Only these are worth marking word by word; see the note at the top. */
const MERGEABLE: ReadonlySet<BlockKind> = new Set(['heading', 'paragraph', 'listItem', 'blockquote'])

/**
 * The syntax that makes a block the kind of block it is: a heading's hashes, a
 * list item's marker, a quote's `>`. Two blocks are only merged when this is
 * identical - a mark inserted in front of `#` would stop the line being a
 * heading at all.
 */
const BLOCK_PREFIX = /^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?))/

/**
 * Words, but with Markdown's inline constructs kept whole.
 *
 * A link, an image, an autolink and a code span are each one token, so a change
 * mark can go around them but never inside their brackets or backticks - where
 * it would break the syntax and the reader would see the raw text instead.
 */
export const MARKDOWN_TOKENS =
  /!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|`[^`\n]+`|<[^>\s]+>|\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu

function wordsBetween(before: MarkdownBlock, after: MarkdownBlock): WordChange[] | null {
  if (before.kind !== after.kind || !MERGEABLE.has(before.kind)) return null
  const prefixBefore = BLOCK_PREFIX.exec(before.text)?.[1] ?? ''
  const prefixAfter = BLOCK_PREFIX.exec(after.text)?.[1] ?? ''
  // Ordered lists renumber themselves when an item is added above, so `3.`
  // becoming `4.` is not a structural change - only the marker's kind is.
  const shape = (prefix: string): string => prefix.replace(/\d+/, '1')
  if (shape(prefixBefore) !== shape(prefixAfter)) return null

  const words = diffWords(
    before.text.slice(prefixBefore.length),
    after.text.slice(prefixAfter.length),
    MARKDOWN_TOKENS
  )
  if (words === null || similarity(words) < MIN_SIMILARITY) return null
  // The prefix goes back on the front, unmarked, as the new version's.
  return [{ op: 'equal', text: prefixAfter }, ...words]
}

/**
 * Pair blocks in two runs - text that was removed, text that was added - as
 * edits wherever one plausibly became the other.
 *
 * Greedy and in order: each removed block takes the first added block after the
 * last pairing that is close enough to be its new version, and the added blocks
 * it skipped over are new. A paragraph inserted above an edited one therefore
 * reads as "new paragraph, then edited paragraph" rather than as a paragraph
 * that turned into a different one.
 */
function pairRun(removed: MarkdownBlock[], added: MarkdownBlock[], rows: PreviewRow[]): void {
  let next = 0
  for (const before of removed) {
    let match = -1
    let words: WordChange[] | null = null
    for (let index = next; index < added.length; index += 1) {
      words = wordsBetween(before, added[index] as MarkdownBlock)
      if (words !== null) {
        match = index
        break
      }
    }
    if (match === -1 || words === null) {
      rows.push({ kind: 'removed', before })
      continue
    }
    for (; next < match; next += 1) rows.push({ kind: 'added', after: added[next] as MarkdownBlock })
    rows.push({ kind: 'changed', before, after: added[match] as MarkdownBlock, words })
    next = match + 1
  }
  for (; next < added.length; next += 1) rows.push({ kind: 'added', after: added[next] as MarkdownBlock })
}

/** Past this many cells the block comparison gives up on alignment. */
const MAX_BLOCK_CELLS = 4_000_000

/**
 * Compare two documents block by block.
 *
 * Blocks match on their text with trailing whitespace ignored, which is the
 * kind of change an editor makes on save and no reader can see.
 */
export function diffMarkdown(before: readonly string[], after: readonly string[]): PreviewRow[] {
  const left = markdownBlocks(before)
  const right = markdownBlocks(after)
  const key = (block: MarkdownBlock): string =>
    `${block.kind}\0${block.text.replace(/[ \t]+$/gm, '')}`
  const a = left.map(key)
  const b = right.map(key)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const rows: PreviewRow[] = []
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ kind: 'same', before: left[index] as MarkdownBlock, after: right[index] as MarkdownBlock })
  }

  const midA = a.length - prefix - suffix
  const midB = b.length - prefix - suffix
  const removedRun: MarkdownBlock[] = []
  const addedRun: MarkdownBlock[] = []
  const flush = (): void => {
    pairRun(removedRun.splice(0), addedRun.splice(0), rows)
  }

  if (midA * midB > MAX_BLOCK_CELLS) {
    // Two unrelated documents of enormous size: everything changed.
    removedRun.push(...left.slice(prefix, prefix + midA))
    addedRun.push(...right.slice(prefix, prefix + midB))
  } else {
    const width = midB + 1
    const table = new Uint32Array((midA + 1) * width)
    for (let i = midA - 1; i >= 0; i -= 1) {
      for (let j = midB - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[prefix + i] === b[prefix + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
      }
    }
    let i = 0
    let j = 0
    while (i < midA || j < midB) {
      if (i < midA && j < midB && a[prefix + i] === b[prefix + j]) {
        flush()
        rows.push({
          kind: 'same',
          before: left[prefix + i] as MarkdownBlock,
          after: right[prefix + j] as MarkdownBlock
        })
        i += 1
        j += 1
      } else if (j >= midB || (i < midA && (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))) {
        removedRun.push(left[prefix + i] as MarkdownBlock)
        i += 1
      } else {
        addedRun.push(right[prefix + j] as MarkdownBlock)
        j += 1
      }
    }
  }
  flush()

  for (let index = 0; index < suffix; index += 1) {
    rows.push({
      kind: 'same',
      before: left[left.length - suffix + index] as MarkdownBlock,
      after: right[right.length - suffix + index] as MarkdownBlock
    })
  }
  return rows
}

/**
 * The private-use characters that carry a change mark through the parser.
 *
 * Private use because nothing in a real document is ever one of them, and
 * because CommonMark treats them as ordinary characters: emphasis next to one
 * still opens and closes the way it would next to a letter.
 */
export const SENTINELS = {
  insertOpen: '',
  insertClose: '',
  deleteOpen: '',
  deleteClose: ''
} as const

/**
 * A changed block's source with its changes marked, for one way of reading it.
 *
 * `merged` is both versions in one - removed words struck out, added words
 * picked out - for the single-column preview. `before` and `after` are each
 * version on its own, with only its own side of the change marked, for the
 * side-by-side one.
 */
export function markedSource(
  words: readonly WordChange[],
  version: 'merged' | 'before' | 'after'
): string {
  let text = ''
  for (const word of words) {
    if (word.op === 'equal') text += word.text
    else if (word.op === 'delete' && version !== 'after') {
      text += SENTINELS.deleteOpen + word.text + SENTINELS.deleteClose
    } else if (word.op === 'insert' && version !== 'before') {
      text += SENTINELS.insertOpen + word.text + SENTINELS.insertClose
    }
  }
  return text
}

/**
 * Fold runs of unchanged blocks down to their edges.
 *
 * A one-sentence edit to a forty-page chapter should not be a forty-page
 * scroll to find. Like the diff's own context, a few blocks either side of
 * every change stay, and what lies between is one row the reader can open.
 * Returns the rows with each folded run replaced by a marker that knows how
 * many rows it stands for and where they start.
 */
export type FoldedRow =
  | { kind: 'row'; row: PreviewRow; index: number }
  | { kind: 'fold'; from: number; count: number }

export function foldUnchanged(
  rows: readonly PreviewRow[],
  context: number,
  opened: ReadonlySet<number>,
  /** Rows that must stay on screen whatever they are - ones with a discussion. */
  keep: ReadonlySet<number> = new Set()
): FoldedRow[] {
  const result: FoldedRow[] = []
  const folds = (at: number): boolean => rows[at]?.kind === 'same' && !keep.has(at)
  let index = 0
  while (index < rows.length) {
    if (!folds(index)) {
      result.push({ kind: 'row', row: rows[index] as PreviewRow, index })
      index += 1
      continue
    }
    let end = index
    while (end < rows.length && folds(end)) end += 1
    // Context only faces a change: the top of the document has nothing above
    // it to keep, and the bottom nothing below.
    const keepBefore = index === 0 ? 0 : context
    const keepAfter = end === rows.length ? 0 : context
    const hidden = end - index - keepBefore - keepAfter
    // Folding fewer than a couple of blocks saves less room than the fold row
    // takes up.
    if (hidden < 3 || opened.has(index + keepBefore)) {
      for (let at = index; at < end; at += 1) result.push({ kind: 'row', row: rows[at] as PreviewRow, index: at })
    } else {
      for (let at = index; at < index + keepBefore; at += 1) {
        result.push({ kind: 'row', row: rows[at] as PreviewRow, index: at })
      }
      result.push({ kind: 'fold', from: index + keepBefore, count: hidden })
      for (let at = end - keepAfter; at < end; at += 1) {
        result.push({ kind: 'row', row: rows[at] as PreviewRow, index: at })
      }
    }
    index = end
  }
  return result
}
