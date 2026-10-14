/**
 * Coverage for comparing two versions of a Markdown document.
 *
 * Two things are load-bearing. Rebuilding the old version from the new one and
 * the hunks must be exact - the preview is otherwise a comparison against a
 * document that never existed - and refuse rather than guess when the inputs
 * disagree. And the block comparison must mark an edit as an edit, a new
 * paragraph as new, and leave structure it cannot merge safely as two blocks.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  diffMarkdown,
  foldUnchanged,
  markdownBlocks,
  markedSource,
  rebuildBase,
  SENTINELS,
  type PreviewRow
} from '../markdown-diff.js'
import type { DiffHunk, FileDiff } from '@shared/git'

function fileWith(hunks: DiffHunk[], status: FileDiff['status'] = 'modified'): FileDiff {
  return {
    path: 'chapter.md',
    oldPath: null,
    status,
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks,
    truncated: false,
    isUntracked: false,
    hasUncommittedChanges: false
  }
}

test('the base is the head with the hunks put back', () => {
  const head = ['a', 'b', 'NEW', 'd', 'e', 'f', 'g']
  const hunk: DiffHunk = {
    header: '@@ -2,3 +2,3 @@',
    oldStart: 2,
    oldLines: 3,
    newStart: 2,
    newLines: 3,
    lines: [
      { type: 'context', content: 'b', oldNumber: 2, newNumber: 2 },
      { type: 'delete', content: 'c', oldNumber: 3, newNumber: null },
      { type: 'insert', content: 'NEW', oldNumber: null, newNumber: 3 },
      { type: 'context', content: 'd', oldNumber: 4, newNumber: 4 }
    ]
  }
  assert.deepEqual(rebuildBase(fileWith([hunk]), head), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
})

test('a hunk that only removes is placed after the line it names', () => {
  const head = ['a', 'b']
  const hunk: DiffHunk = {
    header: '@@ -2 +1,0 @@',
    oldStart: 2,
    oldLines: 1,
    newStart: 1,
    newLines: 0,
    lines: [{ type: 'delete', content: 'gone', oldNumber: 2, newNumber: null }]
  }
  assert.deepEqual(rebuildBase(fileWith([hunk]), head), ['a', 'gone', 'b'])
})

test('a head that does not match the hunks is refused, not guessed at', () => {
  const hunk: DiffHunk = {
    header: '@@ -1 +1 @@',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [{ type: 'context', content: 'expected', oldNumber: 1, newNumber: 1 }]
  }
  assert.equal(rebuildBase(fileWith([hunk]), ['something else']), null)
})

test('a new file has an empty base', () => {
  assert.deepEqual(rebuildBase(fileWith([], 'added'), null), [])
})

test('blocks are paragraphs, headings and single list items, with their lines', () => {
  const blocks = markdownBlocks(['# Title', '', 'Para one', 'continues.', '', '- one', '- two', '', '```', 'code', '', 'more', '```'])
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.start, block.end]),
    [
      ['heading', 1, 1],
      ['paragraph', 3, 4],
      ['listItem', 6, 6],
      ['listItem', 7, 7],
      ['code', 9, 13]
    ]
  )
})

test('front matter is one block and the line numbers after it stay true', () => {
  const blocks = markdownBlocks(['---', 'title: x', '---', '', 'Body'])
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.start, block.end]),
    [
      ['frontmatter', 1, 3],
      ['paragraph', 5, 5]
    ]
  )
})

const kinds = (rows: PreviewRow[]): string[] => rows.map((row) => row.kind)

test('an edited paragraph is one changed row with its words', () => {
  const rows = diffMarkdown(
    ['# Title', '', 'The cat sat on the mat today.'],
    ['# Title', '', 'The cat sat on the rug today.']
  )
  assert.deepEqual(kinds(rows), ['same', 'changed'])
  const changed = rows[1]
  assert.ok(changed?.kind === 'changed')
  assert.equal(
    markedSource(changed.words, 'merged'),
    `The cat sat on the ${SENTINELS.deleteOpen}mat${SENTINELS.deleteClose}${SENTINELS.insertOpen}rug${SENTINELS.insertClose} today.`
  )
  assert.equal(markedSource(changed.words, 'after'), `The cat sat on the ${SENTINELS.insertOpen}rug${SENTINELS.insertClose} today.`)
})

test('a paragraph inserted above an edited one reads as new, then edited', () => {
  const rows = diffMarkdown(
    ['Intro.', '', 'The cat sat on the mat today.'],
    ['Intro.', '', 'A brand new paragraph.', '', 'The cat sat on the rug today.']
  )
  assert.deepEqual(kinds(rows), ['same', 'added', 'changed'])
})

test('a heading kept as a heading merges; a paragraph turned heading does not', () => {
  assert.deepEqual(kinds(diffMarkdown(['## Getting started now'], ['## Getting started today'])), ['changed'])
  assert.deepEqual(kinds(diffMarkdown(['Getting started now'], ['## Getting started now'])), ['removed', 'added'])
})

test('a heading keeps its hashes outside the marks', () => {
  const [row] = diffMarkdown(['## Getting started now'], ['## Getting started today'])
  assert.ok(row?.kind === 'changed')
  assert.ok(markedSource(row.words, 'merged').startsWith('## Getting started '))
})

test('long unchanged runs fold, keeping context next to each change', () => {
  const same = (index: number): PreviewRow => {
    const block = { kind: 'paragraph' as const, start: index, end: index, text: `p${index}` }
    return { kind: 'same', before: block, after: block }
  }
  const rows: PreviewRow[] = [...Array.from({ length: 10 }, (_, index) => same(index)), { kind: 'added', after: { kind: 'paragraph', start: 99, end: 99, text: 'new' } }]
  const folded = foldUnchanged(rows, 2, new Set())
  assert.deepEqual(
    folded.map((entry) => (entry.kind === 'fold' ? `fold ${entry.from}+${entry.count}` : `${entry.index}`)),
    ['fold 0+8', '8', '9', '10']
  )
  // A row the reader opened, or one with a discussion, stays.
  assert.equal(foldUnchanged(rows, 2, new Set([0])).length, 11)
  assert.ok(foldUnchanged(rows, 2, new Set(), new Set([4])).some((entry) => entry.kind === 'row' && entry.index === 4))
})
