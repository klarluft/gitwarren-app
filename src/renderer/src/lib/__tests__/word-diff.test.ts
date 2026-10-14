/**
 * Coverage for the word-level comparison inside a changed line.
 *
 * The property that matters most is that the two lines can be read back off
 * the result exactly - every character of each, in order - because the ranges
 * built from it are cut into text that is then drawn. A diff that dropped or
 * duplicated a character would show the reader a line that is not in the file.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedRanges, diffWords, similarity } from '../word-diff.js'

function rebuild(changes: NonNullable<ReturnType<typeof diffWords>>, side: 'before' | 'after'): string {
  return changes
    .filter((change) => change.op === 'equal' || change.op === (side === 'before' ? 'delete' : 'insert'))
    .map((change) => change.text)
    .join('')
}

test('both versions can be read back off the changes, exactly', () => {
  const pairs = [
    ['The quick brown fox jumps.', 'The quick red fox leaps over.'],
    ['', 'Something new'],
    ['Gone entirely', ''],
    ['Zażółć gęślą jaźń', 'Zażółć gęsią jaźń'],
    ['a, b, c', 'a; b; c']
  ] as const
  for (const [before, after] of pairs) {
    const changes = diffWords(before, after)
    assert.ok(changes)
    assert.equal(rebuild(changes, 'before'), before)
    assert.equal(rebuild(changes, 'after'), after)
  }
})

test('marks only the word that changed', () => {
  const ranges = changedRanges('The cat sat on the mat.', 'The cat sat on the rug.')
  assert.ok(ranges)
  assert.deepEqual(ranges.removed, [{ start: 19, end: 22 }])
  assert.deepEqual(ranges.added, [{ start: 19, end: 22 }])
})

test('a lone space between two edits is part of the edit, not a gap in it', () => {
  const changes = diffWords('one the quick fox', 'one a slow fox')
  assert.ok(changes)
  assert.deepEqual(
    changes.filter((change) => change.op !== 'equal'),
    [
      { op: 'delete', text: 'the quick' },
      { op: 'insert', text: 'a slow' }
    ]
  )
})

test('punctuation is its own token, so an added comma marks only the comma', () => {
  const ranges = changedRanges('However it worked', 'However, it worked')
  assert.ok(ranges)
  assert.deepEqual(ranges.added, [{ start: 7, end: 8 }])
  assert.deepEqual(ranges.removed, [])
})

test('a rewrite is not marked word by word', () => {
  assert.equal(changedRanges('Completely different text here', 'Nothing alike at all, honestly'), null)
})

test('similarity ignores surviving whitespace', () => {
  const changes = diffWords('a b c', 'x y z')
  assert.ok(changes)
  assert.equal(similarity(changes), 0)
})
