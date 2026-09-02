/**
 * Coverage for the palette's matcher.
 *
 * Ordering is the thing worth testing here. Whether a query matches at all is
 * nearly self-evident from the code; whether the right result comes *first* is
 * what the scoring exists for, so most of these compare two candidates rather
 * than assert on an absolute score.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fuzzyMatch, scoreCandidate } from '../fuzzy.js'

function score(query: string, text: string): number {
  const match = fuzzyMatch(query, text)
  assert.ok(match, `expected ${query} to match ${text}`)
  return match.score
}

test('matches characters in order, anywhere', () => {
  assert.ok(fuzzyMatch('nrv', 'New review'))
  assert.equal(fuzzyMatch('vrn', 'New review'), null)
})

test('reports where it matched, so the palette can highlight it', () => {
  const match = fuzzyMatch('rev', 'New review')
  assert.deepEqual(match?.indices, [4, 5, 6])
})

test('an empty query matches everything with nothing highlighted', () => {
  assert.deepEqual(fuzzyMatch('  ', 'anything'), { score: 0, indices: [] })
})

test('word starts beat mid-word letters', () => {
  assert.ok(score('gw', 'git warren') > score('gw', 'gateway'))
})

test('a run of adjacent characters beats the same letters scattered', () => {
  assert.ok(score('diff', 'diff-view.tsx') > score('diff', 'd-i-f-f-notes.txt'))
})

test('a separator starts a word, so a hit just after one scores higher', () => {
  assert.ok(score('ft', 'files-tab') > score('ft', 'filestab'))
  assert.ok(score('rf', 'reviews/files.ts') > score('rf', 'reviewsfiles.ts'))
})

test('a query longer than the text cannot match', () => {
  assert.equal(fuzzyMatch('reviews', 'rev'), null)
})

test('a keyword hit ranks below a label hit', () => {
  const label = scoreCandidate('diff', 'Diff settings')
  const keyword = scoreCandidate('diff', 'Files changed', 'diff patch')
  assert.ok(label && keyword)
  assert.ok(label.score > keyword.score)
  // Highlighting keyword positions would underline letters that are not shown.
  assert.deepEqual(keyword.indices, [])
})
