/**
 * Coverage for find-in-diff.
 *
 * Two things matter here and neither is "does it find the word". One is that an
 * offset can always be used to slice the line it came from, because the marks
 * in the renderer are drawn from these numbers and a shifted one mangles the
 * code it was meant to point at. The other is that hits come back in reading
 * order, since that order *is* what Enter walks.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findDiffMatches, matchOffsets, rowPosition } from '../diff-search.js'
import type { DiffHunk, DiffLine, FileDiff } from '@shared/git'

function line(content: string, oldNumber: number | null, newNumber: number | null): DiffLine {
  return {
    type: oldNumber === null ? 'insert' : newNumber === null ? 'delete' : 'context',
    content,
    oldNumber,
    newNumber
  }
}

function hunk(lines: DiffLine[]): DiffHunk {
  return { header: '@@', oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, lines }
}

function file(path: string, hunks: DiffHunk[]): FileDiff {
  return {
    path,
    oldPath: null,
    status: 'modified',
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks,
    truncated: false,
    isUntracked: false,
    hasUncommittedChanges: false
  }
}

test('finds every occurrence in a line, case-insensitively, without overlapping', () => {
  assert.deepEqual(matchOffsets('Total total TOTAL', 'total'), [0, 6, 12])
  assert.deepEqual(matchOffsets('aaaa', 'aa'), [0, 2])
  assert.deepEqual(matchOffsets('nothing here', 'xyz'), [])
})

test('an empty query matches nothing rather than everything', () => {
  assert.deepEqual(matchOffsets('anything', ''), [])
  assert.deepEqual(findDiffMatches([file('a.ts', [hunk([line('anything', 1, 1)])])], ''), {
    matches: [],
    fileCount: 0,
    truncated: false
  })
})

test('offsets slice the original line, whatever case folding does to its length', () => {
  // `İ` lowercases into two code units, so an offset measured against the
  // folded string would land a character late in the original.
  const content = 'İstanbul map'
  const [offset] = matchOffsets(content, 'map')
  assert.equal(offset !== undefined && content.slice(offset, offset + 3), 'map')
})

test('a hit is addressed to the side of the diff its row is on', () => {
  assert.deepEqual(rowPosition(line('kept', 4, 7)), { side: 'head', number: 7 })
  assert.deepEqual(rowPosition(line('added', null, 7)), { side: 'head', number: 7 })
  assert.deepEqual(rowPosition(line('removed', 4, null)), { side: 'base', number: 4 })
})

test('hits come back in reading order, with the file they are in', () => {
  const files = [
    file('a.ts', [hunk([line('const total = 1', 1, 1), line('sum', 2, 2)])]),
    file('b.ts', [hunk([line('total total', 9, null)])])
  ]

  assert.deepEqual(findDiffMatches(files, 'total'), {
    matches: [
      { filePath: 'a.ts', side: 'head', line: 1, occurrence: 0 },
      { filePath: 'b.ts', side: 'base', line: 9, occurrence: 0 },
      { filePath: 'b.ts', side: 'base', line: 9, occurrence: 1 }
    ],
    fileCount: 2,
    truncated: false
  })
})

test('stops at the ceiling and says so, still counting the file it stopped in', () => {
  const files = [
    file('a.ts', [hunk([line('x', 1, 1)])]),
    file('b.ts', [hunk([line('x x x', 2, 2)])])
  ]

  const found = findDiffMatches(files, 'x', 2)
  assert.equal(found.matches.length, 2)
  assert.equal(found.truncated, true)
  assert.equal(found.fileCount, 2)
})

test('rows the reader cannot be scrolled to are not offered as hits', () => {
  const orphan: DiffLine = { type: 'context', content: 'total', oldNumber: null, newNumber: null }
  assert.deepEqual(findDiffMatches([file('a.ts', [hunk([orphan])])], 'total').matches, [])
})
