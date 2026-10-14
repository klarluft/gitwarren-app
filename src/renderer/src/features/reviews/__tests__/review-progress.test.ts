/**
 * The progress strip counts files, not lines.
 *
 * Worth pinning down because it is the whole reason the strip exists: a lock
 * file regenerated alongside four real changes must be one slot of five, and
 * must not swallow the bar.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fileAt, markRuns, readingPosition, type CardBox } from '../review-progress-model.js'

const PATHS = ['a.ts', 'b.ts', 'package-lock.json', 'c.ts', 'd.ts']

test('neighbouring files in the same state are drawn as one run', () => {
  const runs = markRuns(PATHS, new Set(['a.ts', 'b.ts', 'package-lock.json', 'd.ts']), new Set())
  assert.deepEqual(runs, [
    { mark: 'reviewed', start: 0, length: 3 },
    { mark: 'reviewed', start: 4, length: 1 }
  ])
})

test('a file changed since it was reviewed is a run of its own kind', () => {
  const runs = markRuns(PATHS, new Set(['a.ts']), new Set(['b.ts', 'package-lock.json']))
  assert.deepEqual(runs, [
    { mark: 'reviewed', start: 0, length: 1 },
    { mark: 'changed', start: 1, length: 2 }
  ])
})

test('nothing reviewed is nothing drawn', () => {
  assert.deepEqual(markRuns(PATHS, new Set(), new Set()), [])
})

/** Five cards stacked down the page; the lock file is a hundred times taller. */
const HEIGHTS = [200, 200, 20_000, 200, 200]
function boxes(scrolled: number): (index: number) => CardBox {
  return (index) => {
    let top = -scrolled
    for (let before = 0; before < index; before += 1) top += HEIGHTS[before] ?? 0
    return { top, height: HEIGHTS[index] ?? 0 }
  }
}

test('at the top of the diff the reader is at the start', () => {
  assert.equal(readingPosition(5, 0, boxes(0), false), 0)
})

test('halfway through a short file is half a slot', () => {
  assert.equal(readingPosition(5, 0, boxes(100), false), 0.5)
})

test('the lock file is one slot however long it scrolls', () => {
  // Two short files read and halfway down a file a hundred times their size.
  assert.equal(readingPosition(5, 0, boxes(400 + 10_000), false), 2.5)
  // Past it, the reader is on file four - not four-fifths of the way through
  // the lines of the branch.
  assert.equal(readingPosition(5, 0, boxes(400 + 20_000), false), 3)
})

test('a scroller at its end has shown every file', () => {
  assert.equal(readingPosition(5, 0, boxes(400), true), 5)
})

test('above the first card - the toolbar - is the start', () => {
  assert.equal(readingPosition(5, 0, boxes(-50), false), 0)
})

test('a card missing from the DOM counts as still below the line', () => {
  const box = boxes(250)
  assert.equal(readingPosition(5, 0, (index) => (index >= 2 ? null : box(index)), false), 1.25)
})

test('a point on the strip lands on the slot under it', () => {
  assert.equal(fileAt(5, 0, 500), 0)
  assert.equal(fileAt(5, 250, 500), 2)
  assert.equal(fileAt(5, 499, 500), 4)
  // The far edge itself, and past it, is still the last file.
  assert.equal(fileAt(5, 500, 500), 4)
  assert.equal(fileAt(5, -10, 500), 0)
})
