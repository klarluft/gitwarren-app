/**
 * Coverage for laying a hunk out side by side.
 *
 * What has to hold: every line of the hunk appears exactly once on the side it
 * belongs to, in order, and a removal is set level with the addition that
 * replaced it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitRows, wordChangesFor } from '../split-rows.js'
import type { DiffLine } from '@shared/git'

const context = (old: number, now: number, content = `line ${now}`): DiffLine => ({
  type: 'context',
  content,
  oldNumber: old,
  newNumber: now
})
const removed = (old: number, content = `old ${old}`): DiffLine => ({
  type: 'delete',
  content,
  oldNumber: old,
  newNumber: null
})
const added = (now: number, content = `new ${now}`): DiffLine => ({
  type: 'insert',
  content,
  oldNumber: null,
  newNumber: now
})

test('context sits on both sides of one row', () => {
  const line = context(1, 1)
  assert.deepEqual(splitRows([line]), [{ left: line, right: line }])
})

test('a removal is level with the addition that replaced it', () => {
  const rows = splitRows([context(1, 1), removed(2), removed(3), added(2), added(3), context(4, 4)])
  assert.deepEqual(
    rows.map((row) => [row.left?.oldNumber ?? null, row.right?.newNumber ?? null]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4]
    ]
  )
})

test('the longer side carries on opposite an empty cell', () => {
  const rows = splitRows([removed(1), added(1), added(2), added(3)])
  assert.deepEqual(
    rows.map((row) => [row.left?.oldNumber ?? null, row.right?.newNumber ?? null]),
    [
      [1, 1],
      [null, 2],
      [null, 3]
    ]
  )
})

test('every line appears once, on its own side', () => {
  const lines = [removed(1), removed(2), added(1), context(3, 2), added(3), removed(4)]
  const rows = splitRows(lines)
  const left = rows.flatMap((row) => (row.left === null ? [] : [row.left]))
  const right = rows.flatMap((row) => (row.right === null ? [] : [row.right]))
  assert.deepEqual(left, lines.filter((line) => line.type !== 'insert'))
  assert.deepEqual(right, lines.filter((line) => line.type !== 'delete'))
})

test('edited lines get their changed words; rewrites and context do not', () => {
  const before = removed(1, 'The cat sat on the mat.')
  const after = added(1, 'The cat sat on the rug.')
  const rewriteBefore = removed(2, 'Completely different text here')
  const rewriteAfter = added(2, 'Nothing alike at all, honestly')
  const kept = context(3, 3)
  const changes = wordChangesFor([{ lines: [before, rewriteBefore, after, rewriteAfter, kept] }])
  assert.deepEqual(changes.get(before), [{ start: 19, end: 22 }])
  assert.deepEqual(changes.get(after), [{ start: 19, end: 22 }])
  assert.equal(changes.has(rewriteBefore), false)
  assert.equal(changes.has(kept), false)
})
