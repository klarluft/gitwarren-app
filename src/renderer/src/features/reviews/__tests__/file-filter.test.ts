/**
 * The ranking behind both file lists' filter boxes.
 *
 * What is worth pinning down is the *order*, because that is the whole point of
 * the thing: a flat list of matches is only better than a tree if the one you
 * meant is at the top of it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { filterPaths, MAX_FILTER_MATCHES } from '../file-filter.js'

const PATHS = [
  'src/renderer/src/features/reviews/review-files-tab.tsx',
  'src/renderer/src/features/reviews/repository-files-tree.tsx',
  'src/renderer/src/features/reviews/file-path.tsx',
  'src/shared/routes.ts',
  'src/core/git-search.ts',
  'README.md'
]

test('an empty query is not a filter', () => {
  assert.deepEqual(filterPaths(PATHS, ''), { shown: [], total: 0 })
  assert.deepEqual(filterPaths(PATHS, '   '), { shown: [], total: 0 })
})

test('a query names a file, and that file comes first', () => {
  const { shown } = filterPaths(PATHS, 'routes')
  assert.equal(shown[0]?.path, 'src/shared/routes.ts')
})

test('initials reach a file nobody would want to type the path of', () => {
  const { shown } = filterPaths(PATHS, 'rft')
  assert.equal(shown[0]?.path, 'src/renderer/src/features/reviews/review-files-tab.tsx')
})

test('the hit positions come back, so a row can show why it matched', () => {
  const { shown } = filterPaths(['src/app.ts'], 'app')
  const match = shown[0]

  assert.ok(match !== undefined)
  assert.deepEqual(
    match.indices.map((at) => match.path[at]).join(''),
    'app'
  )
})

test('what does not match is not in the list at all', () => {
  const { shown, total } = filterPaths(PATHS, 'zzzz')
  assert.deepEqual(shown, [])
  assert.equal(total, 0)
})

test('the total counts everything that matched, not only what is shown', () => {
  const many = Array.from({ length: MAX_FILTER_MATCHES + 25 }, (_, at) => `src/file-${at}.ts`)
  const { shown, total } = filterPaths(many, 'file')

  assert.equal(shown.length, MAX_FILTER_MATCHES)
  assert.equal(total, many.length)
})

test('ties break on the path, so a refreshed list does not reshuffle under the cursor', () => {
  const forwards = filterPaths(['b/x.ts', 'a/x.ts'], 'x.ts')
  const backwards = filterPaths(['a/x.ts', 'b/x.ts'], 'x.ts')

  assert.deepEqual(
    forwards.shown.map((match) => match.path),
    backwards.shown.map((match) => match.path)
  )
})
