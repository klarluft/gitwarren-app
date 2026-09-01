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

import { snippetAt, threadSnippet } from '../comment-snippets.js'
import type { DiffHunk, DiffLine, FileDiff } from '../git.js'
import type { AnchorSnapshot, CommentThread } from '../schemas.js'

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

/* -------------------------------------------------------------------------- */
/* Choosing between the live diff and the stored snapshot                     */
/* -------------------------------------------------------------------------- */

function threadOn(line: number | null, overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 1,
    reviewId: 1,
    filePath: line === null ? null : 'src/app.ts',
    side: line === null ? null : 'head',
    line,
    anchorText: line === null ? null : 'four',
    anchorSha: 'abc1234def',
    anchorSnapshot: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    comments: [],
    ...overrides
  }
}

const snapshot: AnchorSnapshot = {
  lines: [
    { type: 'context', content: 'three (as written)', oldNumber: 3, newNumber: 3 },
    { type: 'context', content: 'four (as written)', oldNumber: 4, newNumber: 4 }
  ],
  clipped: true
}

test('a live comment is shown against the code as it is now', () => {
  const shown = threadSnippet(threadOn(4), { state: 'anchored', line: 4 }, file)

  assert.deepEqual(
    shown?.lines.map((line) => line.content),
    ['one', 'two', 'three', 'four']
  )
  assert.equal(shown?.historical, false)
  assert.equal(shown?.state, 'anchored')
})

test('the live diff wins over the snapshot while the comment still anchors', () => {
  const shown = threadSnippet(
    threadOn(4, { anchorSnapshot: snapshot }),
    { state: 'anchored', line: 4 },
    file
  )

  assert.deepEqual(
    shown?.lines.map((line) => line.content),
    ['one', 'two', 'three', 'four']
  )
  assert.equal(shown?.historical, false)
})

test('once the code is gone the snapshot is shown, and marked as history', () => {
  const shown = threadSnippet(
    threadOn(4, { anchorSnapshot: snapshot }),
    { state: 'outdated', line: null },
    file
  )

  assert.deepEqual(
    shown?.lines.map((line) => line.content),
    ['three (as written)', 'four (as written)']
  )
  assert.equal(shown?.historical, true)
  assert.equal(shown?.state, 'outdated')
  // The stored line, since there is no current one to report.
  assert.equal(shown?.line, 4)
  assert.equal(shown?.clipped, true)
})

test('a thread older than snapshots falls back to its one stored line', () => {
  const shown = threadSnippet(threadOn(4), { state: 'outdated', line: null }, undefined)

  assert.deepEqual(
    shown?.lines.map((line) => line.content),
    ['four']
  )
  assert.equal(shown?.historical, true)
})

test('a thread with nothing stored has nothing to show', () => {
  const shown = threadSnippet(
    threadOn(4, { anchorText: null }),
    { state: 'outdated', line: null },
    undefined
  )

  assert.deepEqual(shown?.lines, [])
})

test('while the diff is still loading the snapshot makes no claim about the branch', () => {
  // `anchor` is null: the app does not know yet where this comment lands, so
  // calling the snapshot outdated - or calling it current - would both be
  // guesses.
  const shown = threadSnippet(threadOn(4, { anchorSnapshot: snapshot }), null, undefined)

  assert.deepEqual(
    shown?.lines.map((line) => line.content),
    ['three (as written)', 'four (as written)']
  )
  assert.equal(shown?.historical, false)
  assert.equal(shown?.state, 'anchored')
})

test('a comment that moved is shown at the line it moved to', () => {
  const shown = threadSnippet(threadOn(2), { state: 'moved', line: 4 }, file)

  assert.equal(shown?.line, 4)
  assert.equal(shown?.state, 'moved')
  assert.equal(shown?.historical, false)
})

test('a review-level thread has no code to show', () => {
  assert.equal(threadSnippet(threadOn(null), null, undefined), null)
})
