/**
 * Unit coverage for the code snippet shown above a comment in the conversation
 * tab.
 *
 * The interesting cases are all about honesty: the commented line has to be the
 * last one shown, the lead-in must not reach across a hunk boundary into code
 * that is somewhere else in the file, and a line the diff does not contain must
 * come back as nothing rather than as a nearby guess.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { snippetAt } from '../comment-snippets.js'
import type { DiffHunk, DiffLine, FileDiff } from '../git.js'

/** `[type, content, oldNumber, newNumber]`, so the tests read as diffs. */
type Row = [DiffLine['type'], string, number | null, number | null]

function hunk(header: string, rows: Row[]): DiffHunk {
  return {
    header,
    oldStart: 1,
    oldLines: rows.length,
    newStart: 1,
    newLines: rows.length,
    lines: rows.map(([type, content, oldNumber, newNumber]) => ({
      type,
      content,
      oldNumber,
      newNumber
    }))
  }
}

function fileWith(hunks: DiffHunk[]): FileDiff {
  return {
    path: 'src/app.ts',
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

const file = fileWith([
  hunk('@@ -1,6 +1,6 @@', [
    ['context', 'one', 1, 1],
    ['context', 'two', 2, 2],
    ['context', 'three', 3, 3],
    ['context', 'four', 4, 4],
    ['delete', 'five old', 5, null],
    ['insert', 'five new', null, 5]
  ]),
  hunk('@@ -40,2 +40,2 @@', [
    ['context', 'forty', 40, 40],
    ['insert', 'forty one', null, 41]
  ])
])

test('the commented line comes last, under its lead-in', () => {
  const snippet = snippetAt(file, 'head', 4)

  assert.deepEqual(
    snippet?.lines.map((line) => line.content),
    ['one', 'two', 'three', 'four']
  )
  assert.equal(snippet?.clipped, false)
})

test('the lead-in is capped, and says so', () => {
  const snippet = snippetAt(file, 'head', 5)

  assert.deepEqual(
    snippet?.lines.map((line) => line.content),
    ['three', 'four', 'five old', 'five new']
  )
  // 'one' and 'two' are above the window; the reader is told the file did not
  // start here.
  assert.equal(snippet?.clipped, true)
})

test('a short lead-in is not padded from the previous hunk', () => {
  const snippet = snippetAt(file, 'head', 40)

  assert.deepEqual(
    snippet?.lines.map((line) => line.content),
    ['forty']
  )
  assert.equal(snippet?.clipped, false)
})

test('the base side numbers by the base, and can land on a deleted line', () => {
  const snippet = snippetAt(file, 'base', 5)

  assert.deepEqual(
    snippet?.lines.map((line) => line.content),
    ['two', 'three', 'four', 'five old']
  )
})

test('a line the diff does not show has no snippet', () => {
  // Line 41 exists on head but not on base: it is an insertion.
  assert.equal(snippetAt(file, 'base', 41), null)
  assert.equal(snippetAt(file, 'head', 999), null)
})

test('with no file there is nothing to quote', () => {
  assert.equal(snippetAt(undefined, 'head', 1), null)
})

test('the context width is adjustable', () => {
  const snippet = snippetAt(file, 'head', 4, 1)

  assert.deepEqual(
    snippet?.lines.map((line) => line.content),
    ['three', 'four']
  )
  assert.equal(snippet?.clipped, true)
})
