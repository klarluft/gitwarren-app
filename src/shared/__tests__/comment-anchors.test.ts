/**
 * Unit coverage for re-anchoring comments after the branch moves.
 *
 * This is the piece with a real chance of being subtly wrong, and the failure
 * mode is nasty and silent: a comment shown confidently next to code it was
 * never about. The cases below are the ones that actually happen while a review
 * is open - lines pushed down by an insert above, the commented line rewritten,
 * the file renamed, the same text appearing several times.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findAnchorFile, isInlineAnchor, resolveAnchor } from '../comment-anchors.js'
import type { DiffLine, FileDiff } from '../git.js'

/**
 * Build a one-hunk file diff from a compact description.
 *
 * Each entry is `[type, content, oldNumber, newNumber]`, which keeps the tests
 * readable as diffs rather than as object literals.
 */
function fileWith(
  path: string,
  lines: [DiffLine['type'], string, number | null, number | null][],
  overrides: Partial<FileDiff> = {}
): FileDiff {
  return {
    path,
    oldPath: null,
    status: 'modified',
    isBinary: false,
    additions: lines.filter(([type]) => type === 'insert').length,
    deletions: lines.filter(([type]) => type === 'delete').length,
    hunks: [
      {
        header: '@@',
        oldStart: 1,
        oldLines: lines.length,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map(([type, content, oldNumber, newNumber]) => ({
          type,
          content,
          oldNumber,
          newNumber
        }))
      }
    ],
    truncated: false,
    isUntracked: false,
    hasUncommittedChanges: false,
    ...overrides
  }
}

const file = fileWith('src/app.ts', [
  ['context', 'const a = 1', 1, 1],
  ['context', 'const b = 2', 2, 2],
  ['insert', 'const c = 3', null, 3]
])

test('an untouched line stays anchored where it was', () => {
  const resolved = resolveAnchor(file, {
    filePath: 'src/app.ts',
    side: 'head',
    line: 2,
    anchorText: 'const b = 2'
  })

  assert.deepEqual(resolved, { state: 'anchored', line: 2 })
})

test('a line pushed down by an insert above follows its text', () => {
  // Same file after `const zero = 0` was added at the top: every line below it
  // now has a number one higher, and a comment left on line 2 is about line 3.
  const shifted = fileWith('src/app.ts', [
    ['insert', 'const zero = 0', null, 1],
    ['context', 'const a = 1', 1, 2],
    ['context', 'const b = 2', 2, 3]
  ])

  const resolved = resolveAnchor(shifted, {
    filePath: 'src/app.ts',
    side: 'head',
    line: 2,
    anchorText: 'const b = 2'
  })

  assert.deepEqual(resolved, { state: 'moved', line: 3 })
})

test('a rewritten line goes outdated rather than pointing at the new code', () => {
  const rewritten = fileWith('src/app.ts', [
    ['context', 'const a = 1', 1, 1],
    ['insert', 'const b = 99', null, 2]
  ])

  const resolved = resolveAnchor(rewritten, {
    filePath: 'src/app.ts',
    side: 'head',
    line: 2,
    anchorText: 'const b = 2'
  })

  assert.deepEqual(resolved, { state: 'outdated', line: null })
})

test('a file that has dropped out of the diff goes outdated', () => {
  const resolved = resolveAnchor(undefined, {
    filePath: 'src/gone.ts',
    side: 'head',
    line: 1,
    anchorText: 'whatever'
  })

  assert.deepEqual(resolved, { state: 'outdated', line: null })
})

test('with no captured text there is nothing to verify, so it is outdated', () => {
  // This is the thread opened on a line the diff never showed. The line number
  // may well still exist - claiming it is the right one would be a guess.
  const resolved = resolveAnchor(file, {
    filePath: 'src/app.ts',
    side: 'head',
    line: 2,
    anchorText: null
  })

  assert.deepEqual(resolved, { state: 'outdated', line: null })
})

test('among identical lines the nearest one wins', () => {
  // Three closing braces and a comment that used to sit on line 8. Nothing can
  // recover which brace was meant, so the rule is simply "closest to where it
  // was" - a near miss inside the right file beats dropping the comment out of
  // it. Exact ties keep the earlier line, which is arbitrary but deterministic.
  const braces = fileWith('src/app.ts', [
    ['context', '}', 1, 1],
    ['context', 'x', 2, 2],
    ['context', '}', 3, 3],
    ['context', 'y', 4, 4],
    ['context', '}', 5, 5]
  ])

  const resolved = resolveAnchor(braces, {
    filePath: 'src/app.ts',
    side: 'head',
    line: 8,
    anchorText: '}'
  })

  assert.deepEqual(resolved, { state: 'moved', line: 5 })
})

test('base-side anchors use base numbers, and ignore inserted lines', () => {
  // `const b = 2` exists only on the head side here, so a base-side anchor for
  // it must not latch onto it.
  const resolved = resolveAnchor(file, {
    filePath: 'src/app.ts',
    side: 'base',
    line: 3,
    anchorText: 'const c = 3'
  })

  assert.deepEqual(resolved, { state: 'outdated', line: null })
})

test('a deleted line is anchorable on the base side', () => {
  const withDeletion = fileWith('src/app.ts', [
    ['context', 'keep', 1, 1],
    ['delete', 'gone', 2, null]
  ])

  const resolved = resolveAnchor(withDeletion, {
    filePath: 'src/app.ts',
    side: 'base',
    line: 2,
    anchorText: 'gone'
  })

  assert.deepEqual(resolved, { state: 'anchored', line: 2 })
})

test('a renamed file is found under either name', () => {
  const renamed = fileWith('src/new.ts', [['context', 'x', 1, 1]], {
    oldPath: 'src/old.ts',
    status: 'renamed'
  })

  assert.equal(findAnchorFile([renamed], 'src/old.ts'), renamed)
  assert.equal(findAnchorFile([renamed], 'src/new.ts'), renamed)
  assert.equal(findAnchorFile([renamed], 'src/other.ts'), undefined)
})

test('inline threads are told apart from review-level ones', () => {
  assert.equal(isInlineAnchor({ filePath: 'a.ts', side: 'head', line: 1 }), true)
  assert.equal(isInlineAnchor({ filePath: null, side: null, line: null }), false)
  // A half-filled anchor is not inline: all three columns are written together.
  assert.equal(isInlineAnchor({ filePath: 'a.ts', side: 'head', line: null }), false)
})
