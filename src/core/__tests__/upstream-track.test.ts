/**
 * Coverage for reading git's upstream-tracking summary.
 *
 * `%(upstream:track)` is written for people rather than for parsers, and the
 * shapes below are the whole vocabulary it uses. The empty case is the one that
 * matters most in practice - it is what a branch level with its upstream
 * produces, which is the common case, and reading it as anything other than
 * "no drift" would put a warning on every review in the app.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUpstreamTrack } from '../git-compare.js'

test('a branch level with its upstream reports no drift', () => {
  assert.deepEqual(parseUpstreamTrack(''), { ahead: 0, behind: 0, gone: false })
  assert.deepEqual(parseUpstreamTrack('   '), { ahead: 0, behind: 0, gone: false })
})

test('reads a branch that is only behind', () => {
  assert.deepEqual(parseUpstreamTrack('behind 11'), { ahead: 0, behind: 11, gone: false })
})

test('reads a branch that is only ahead', () => {
  assert.deepEqual(parseUpstreamTrack('ahead 2'), { ahead: 2, behind: 0, gone: false })
})

test('reads a branch that has diverged in both directions', () => {
  assert.deepEqual(parseUpstreamTrack('ahead 1, behind 3'), { ahead: 1, behind: 3, gone: false })
})

test('a deleted upstream is flagged rather than counted', () => {
  assert.deepEqual(parseUpstreamTrack('gone'), { ahead: 0, behind: 0, gone: true })
})

test('still parses when git brings its own brackets', () => {
  // `nobracket` is asked for, but a stray bracket must not turn 11 into NaN.
  assert.deepEqual(parseUpstreamTrack('[behind 11]'), { ahead: 0, behind: 11, gone: false })
})
