/**
 * Unit coverage for the gap arithmetic behind "show more lines".
 *
 * The cases here are the ones that decide whether an unfolded line lands on the
 * right number: a diff that does not start at line 1, a hunk that only deletes,
 * and the running offset between the two sides once a change has grown or
 * shrunk the file.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { continuesFromAbove, fileGaps, gapLength, segmentGap } from '../diff-gaps.js'
import type { DiffHunk } from '../git.js'

function hunk(oldStart: number, oldLines: number, newStart: number, newLines: number): DiffHunk {
  return {
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines: []
  }
}

test('a hunk that starts past line 1 leaves a gap above it', () => {
  const gaps = fileGaps([hunk(10, 6, 10, 7)], { includeTail: false })

  assert.deepEqual(gaps, [{ start: 1, end: 9, delta: 0, beforeHunk: 0 }])
})

test('a diff starting at line 1 has no gap above it', () => {
  const gaps = fileGaps([hunk(1, 3, 1, 4)], { includeTail: false })

  assert.deepEqual(gaps, [])
})

test('the gap between two hunks carries the offset between the sides', () => {
  // The first hunk adds two lines, so everything after it sits two lines lower
  // on the head side than on the base side.
  const gaps = fileGaps([hunk(1, 3, 1, 5), hunk(20, 4, 22, 4)], { includeTail: false })

  assert.deepEqual(gaps, [{ start: 6, end: 21, delta: 2, beforeHunk: 1 }])
})

test('the tail runs from the last hunk to wherever the file ends', () => {
  const gaps = fileGaps([hunk(1, 3, 1, 5)], { includeTail: true })
  const tail = gaps[gaps.length - 1]

  assert.deepEqual(tail, { start: 6, end: null, delta: 2, beforeHunk: 1 })
  assert.equal(gapLength(tail as never, null), null, 'unknown until the file is read')
  assert.equal(gapLength(tail as never, 40), 35)
})

test('a hunk that only deletes shows nothing of the head side', () => {
  // `@@ -5,3 +4,0 @@` - three base lines removed, after head line 4. The head
  // side of that hunk is empty, so head lines 1..4 are all still hidden.
  const gaps = fileGaps([hunk(5, 3, 4, 0), hunk(20, 3, 17, 3)], { includeTail: true })

  assert.deepEqual(gaps[0], { start: 1, end: 4, delta: 0, beforeHunk: 0 })
  // Head lines 5..16 are hidden too, and now sit three lines above their base
  // counterparts, the deletion having happened between them.
  assert.deepEqual(gaps[1], { start: 5, end: 16, delta: -3, beforeHunk: 1 })
})

test('an unread gap segments into one hidden run', () => {
  const [gap] = fileGaps([hunk(30, 3, 30, 3)], { includeTail: false })

  assert.deepEqual(segmentGap(gap as never, new Set(), null), [
    { kind: 'hidden', start: 1, end: 29 }
  ])
})

test('unfolding part of a gap leaves the rest folded on both sides of it', () => {
  const [gap] = fileGaps([hunk(30, 3, 30, 3)], { includeTail: false })
  const revealed = new Set([10, 11, 12])

  assert.deepEqual(segmentGap(gap as never, revealed, null), [
    { kind: 'hidden', start: 1, end: 9 },
    { kind: 'revealed', start: 10, end: 12 },
    { kind: 'hidden', start: 13, end: 29 }
  ])
})

test('the tail cannot be segmented until the length of the file is known', () => {
  const gaps = fileGaps([hunk(1, 3, 1, 3)], { includeTail: true })
  const tail = gaps[gaps.length - 1] as never

  assert.deepEqual(segmentGap(tail, new Set(), null), [])
  assert.deepEqual(segmentGap(tail, new Set(), 10), [{ kind: 'hidden', start: 4, end: 10 }])
  // A file that ends exactly where the last hunk does has no tail to show.
  assert.deepEqual(segmentGap(tail, new Set(), 3), [])
})

test('revealing past the end of the file is clamped to the last line', () => {
  const gaps = fileGaps([hunk(1, 3, 1, 3)], { includeTail: true })
  const tail = gaps[gaps.length - 1] as never
  const revealed = new Set(Array.from({ length: 100 }, (_value, index) => index + 4))

  assert.deepEqual(segmentGap(tail, revealed, 6), [{ kind: 'revealed', start: 4, end: 6 }])
})

/* -------------------------------------------------------------------------- */
/* Whether a hunk has a break above it to announce                            */
/* -------------------------------------------------------------------------- */

test('a hunk starting at line 1 has nothing above it', () => {
  assert.equal(continuesFromAbove([hunk(1, 3, 1, 4)], 0), true)
})

test('a whole new file continues from the start of the file', () => {
  // `@@ -0,0 +1,120 @@` - what git prints for a file that did not exist.
  assert.equal(continuesFromAbove([hunk(0, 0, 1, 120)], 0), true)
})

test('a whole deleted file continues from the start of the file', () => {
  // `@@ -1,120 +0,0 @@` - the head side is empty, and begins where it ends.
  assert.equal(continuesFromAbove([hunk(1, 120, 0, 0)], 0), true)
})

test('a hunk starting further down has a break above it', () => {
  assert.equal(continuesFromAbove([hunk(10, 6, 10, 7)], 0), false)
})

test('two hunks that touch are one continuous run', () => {
  const hunks = [hunk(1, 5, 1, 5), hunk(6, 4, 6, 4)]

  assert.equal(continuesFromAbove(hunks, 1), true)
  assert.deepEqual(fileGaps(hunks, { includeTail: false }), [])
})

test('two hunks with lines between them are not', () => {
  const hunks = [hunk(1, 5, 1, 5), hunk(20, 4, 20, 4)]

  assert.equal(continuesFromAbove(hunks, 1), false)
  assert.equal(fileGaps(hunks, { includeTail: false }).length, 1)
})

test('every discontinuity that is not a continuation produces a gap', () => {
  // The property the `@@` header rule leans on: when gaps are being tracked,
  // a hunk either continues from above or has a gap of its own, never neither.
  const hunks = [hunk(0, 0, 1, 4), hunk(12, 3, 12, 5), hunk(17, 2, 19, 2)]
  const gaps = new Set(fileGaps(hunks, { includeTail: false }).map((gap) => gap.beforeHunk))

  for (const index of hunks.keys()) {
    assert.ok(
      continuesFromAbove(hunks, index) !== gaps.has(index),
      `hunk ${index} should either continue from above or have a gap, exactly one`
    )
  }
})
