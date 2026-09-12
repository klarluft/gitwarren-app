/**
 * The display helpers, with the clock and the locale held still.
 *
 * Everything in `format.ts` reaches for `Intl`, which reads a locale from the
 * environment, so the assertions here are about the shape of the output rather
 * than its exact wording: a runner on a machine set to German is not a failing
 * test, and asserting on "3 days ago" would make it one. Where a case is about
 * a locale-independent decision - which unit was picked, whether a number was
 * grouped at all, what an unknown size draws - it is asserted exactly.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { absoluteTime, fileSize, plural, relativeTime, timeOfDay } from '../format'

const DAY = 24 * 60 * 60 * 1000

test('nothing is drawn for a timestamp that was never set', () => {
  assert.equal(relativeTime(null), '')
  assert.equal(absoluteTime(null), '')
})

test('an unparseable timestamp is handed back rather than swallowed', () => {
  assert.equal(relativeTime('not a date'), 'not a date')
  assert.equal(absoluteTime('not a date'), 'not a date')
})

test('the largest unit that fits is the one the phrase uses', () => {
  const parts = new Intl.RelativeTimeFormat().formatToParts(-3, 'day')
  const dayWord = parts.map((part) => part.value).join('')

  const threeDaysAgo = new Date(Date.now() - 3 * DAY).toISOString()
  assert.equal(relativeTime(threeDaysAgo), dayWord)
})

test('anything under a minute is just now, in either direction', () => {
  assert.equal(relativeTime(new Date(Date.now() - 5_000).toISOString()), 'just now')
  assert.equal(relativeTime(new Date(Date.now() + 5_000).toISOString()), 'just now')
})

test('a clock time says nothing about the date it came from', () => {
  const noon = Date.UTC(2026, 0, 1, 12, 0, 0)
  assert.ok(!timeOfDay(noon).includes('2026'))
})

test('bytes stay bytes below a kilobyte', () => {
  assert.equal(fileSize(0), '0 B')
  assert.equal(fileSize(1023), '1023 B')
})

test('the unit climbs and the precision drops as the number grows', () => {
  assert.equal(fileSize(1024), '1.0 KB')
  assert.equal(fileSize(412 * 1024), '412 KB')
  assert.equal(fileSize(5.5 * 1024 * 1024), '5.5 MB')
})

test('the top unit is gigabytes rather than an unbounded ladder', () => {
  assert.equal(fileSize(4096 * 1024 * 1024 * 1024), '4096 GB')
})

test('a size nobody knows draws a dash instead of NaN', () => {
  assert.equal(fileSize(Number.NaN), '—')
  assert.equal(fileSize(Number.POSITIVE_INFINITY), '—')
  assert.equal(fileSize(-1), '—')
})

test('one of something is singular and everything else is not', () => {
  assert.equal(plural(1, 'file'), '1 file')
  assert.equal(plural(0, 'file'), '0 files')
  assert.equal(plural(3, 'file'), '3 files')
})

test('an irregular plural is spelled by the caller', () => {
  assert.equal(plural(2, 'entry', 'entries'), '2 entries')
})

test('a four-figure count is grouped rather than run together', () => {
  const grouped = plural(24000, 'file')
  assert.ok(grouped.endsWith(' files'))
  assert.notEqual(grouped, '24000 files')
})
