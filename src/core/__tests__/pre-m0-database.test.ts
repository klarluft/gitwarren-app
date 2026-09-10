/**
 * Opening a database that was written before M0 existed.
 *
 * This is the milestone's acceptance test, and it is deliberately not a unit
 * test of the migration. M0 adds a table, two columns and a data step that no
 * SQL file could contain, and the only claim worth checking is the one a user
 * would make: their reviews and their comments are still there afterwards, they
 * still say who wrote them, and what they write next is attributed to them.
 *
 * The "before" database is built by running the migrations *as they stood at
 * 0006* rather than by committing a binary fixture. A fixture would be opaque -
 * nobody reviews a .db file in a diff - and would rot silently; this way the
 * starting point is the real schema history, and rebuilding it is one loop.
 */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

/** The last migration that shipped before M0. */
const LAST_PRE_M0_MIGRATION = 6

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-pre-m0-data-'))
const migrationsDir = mkdtempSync(join(tmpdir(), 'gitwarren-pre-m0-migrations-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { getDatabasePath } = await import('../paths.js')
const { getInstanceId } = await import('../instance.js')
const { HUMAN_NAME, HUMAN_AUTHOR } = await import('../../shared/actors.js')

/**
 * A second connection on the same file, for asking the database what it holds
 * without going through the code being tested.
 */
let raw: Database.Database

after(async () => {
  raw?.close()

  // The app's own connection is a module-level singleton, and the last test in
  // this file reopens it deliberately, so it is still holding the database file
  // when this runs. POSIX is happy to unlink a file someone has open and
  // Windows is not: `rmSync` fails there with EPERM and takes every test in the
  // file down with it. Closed rather than left to the process exiting, because
  // the directory has to be gone before that.
  const { closeDatabase } = await import('../db/client.js')
  closeDatabase()

  rmSync(dataDir, { recursive: true, force: true })
  rmSync(migrationsDir, { recursive: true, force: true })
})

/**
 * A copy of the migrations folder with everything after M0's predecessor cut
 * out - the schema exactly as an installed 0.1.6 would have it.
 */
function buildPreM0Migrations(): void {
  cpSync('drizzle', migrationsDir, { recursive: true })

  const journalPath = join(migrationsDir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[]
  }
  const dropped = journal.entries.filter((entry) => entry.idx > LAST_PRE_M0_MIGRATION)
  journal.entries = journal.entries.filter((entry) => entry.idx <= LAST_PRE_M0_MIGRATION)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8')

  for (const entry of dropped) {
    rmSync(join(migrationsDir, `${entry.tag}.sql`), { force: true })
  }

  assert.ok(dropped.length > 0, 'there is no post-0006 migration to test the upgrade of')
}

/** Rows a user would have had: one repository, one review, a discussion. */
function seedPreM0Database(): void {
  const sqlite = new Database(getDatabasePath())
  sqlite.pragma('foreign_keys = ON')
  migrate(drizzle(sqlite), { migrationsFolder: migrationsDir })

  // The old schema has no `host_id` and no `author_id`, so naming the columns
  // explicitly is both correct and a check that they really are absent.
  sqlite
    .prepare('INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)')
    .run(1, '/work/an-old-project', 'an-old-project')
  sqlite
    .prepare(
      'INSERT INTO reviews (id, repository_id, title, base_ref, head_ref) VALUES (?, ?, ?, ?, ?)'
    )
    .run(1, 1, 'Something from before', 'main', 'feature')
  sqlite.prepare('INSERT INTO comment_threads (id, review_id) VALUES (?, ?)').run(1, 1)

  const insertComment = sqlite.prepare(
    'INSERT INTO comments (id, thread_id, author_kind, author_name, author_label, author_session, body) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insertComment.run(1, 1, 'human', HUMAN_NAME, null, null, 'I wrote this before any of it existed.')
  insertComment.run(2, 1, 'agent', 'Claude Code', 'auth-refactor', 'aaaa1111', 'And I replied.')

  sqlite.close()
}

before(async () => {
  buildPreM0Migrations()
  seedPreM0Database()

  // Opening through the app is what applies M0 and runs the data step.
  const { getDatabase } = await import('../db/client.js')
  getDatabase()
  raw = new Database(getDatabasePath())
})

/**
 * `rows[index]`, having first said that there is one.
 *
 * Index access is checked in this project, and a `?.` on every row read would
 * bury what each test below is actually asserting under punctuation.
 */
function at<T>(rows: T[], index = 0): T {
  const row = rows[index]
  assert.ok(row !== undefined, `expected a row at index ${index}, got ${rows.length} rows`)
  return row
}

function comments(): {
  id: number
  author_kind: string
  author_name: string
  author_session: string | null
  author_id: number | null
}[] {
  return raw
    .prepare(
      'SELECT id, author_kind, author_name, author_session, author_id FROM comments ORDER BY id'
    )
    .all() as ReturnType<typeof comments>
}

function principals(): { id: number; kind: string; identifier: string; display_name: string }[] {
  return raw
    .prepare('SELECT id, kind, identifier, display_name FROM principals ORDER BY id')
    .all() as ReturnType<typeof principals>
}

test('the old database opens, and the M0 schema arrives with it', () => {
  const columns = (table: string): string[] =>
    (raw.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name)

  assert.ok(columns('repositories').includes('host_id'))
  assert.ok(columns('comments').includes('author_id'))
  assert.ok(columns('principals').includes('identifier'))
})

test('the reviews and comments that were there are still there, unchanged', async () => {
  const { repositoriesService } = await import('../services/repositories.js')
  const { reviewsService } = await import('../services/reviews.js')
  const { commentsService } = await import('../services/comments.js')

  const tracked = await repositoriesService.list()
  assert.equal(tracked.length, 1)
  assert.equal(at(tracked).path, '/work/an-old-project')
  assert.equal(at(tracked).name, 'an-old-project')

  const reviews = await reviewsService.list({ repositoryId: 1 })
  assert.equal(reviews.length, 1)
  assert.equal(at(reviews).title, 'Something from before')

  const threads = await commentsService.list({ reviewId: 1 })
  assert.equal(threads.length, 1)
  assert.deepEqual(
    at(threads).comments.map((comment) => comment.body),
    ['I wrote this before any of it existed.', 'And I replied.']
  )
})

test('the repository is local, which is spelled as no host at all', () => {
  const row = raw.prepare('SELECT host_id FROM repositories WHERE id = 1').get() as {
    host_id: string | null
  }
  assert.equal(row.host_id, null)
})

test('the old human comment is adopted by the local principal', () => {
  // Exactly one: this install's own. Opening the database twice must not mint
  // a second, which is what the unique index over (kind, identifier) is for.
  assert.equal(principals().length, 1)
  const principal = at(principals())
  assert.equal(principal.kind, 'local')
  assert.equal(principal.identifier, getInstanceId())
  assert.equal(principal.display_name, HUMAN_NAME)

  const human = at(comments(), 0)
  assert.equal(human.author_kind, 'human')
  assert.equal(human.author_id, principal.id)

  // The agent's comment keeps the identity it arrived with and gains no
  // principal: a session is a process, not a person.
  const agent = at(comments(), 1)
  assert.equal(agent.author_kind, 'agent')
  assert.equal(agent.author_name, 'Claude Code')
  assert.equal(agent.author_session, 'aaaa1111')
  assert.equal(agent.author_id, null)
})

test('a comment written now carries the local principal', async () => {
  const { commentsService } = await import('../services/comments.js')

  const thread = await commentsService.createThread(
    { reviewId: 1, body: 'And this one is from after the upgrade.' },
    HUMAN_AUTHOR
  )

  const written = raw
    .prepare('SELECT author_id, author_kind FROM comments WHERE id = ?')
    .get(at(thread.comments).id) as { author_id: number | null; author_kind: string }

  assert.equal(written.author_kind, 'human')
  assert.equal(written.author_id, at(principals()).id)
})

test('an agent writing now still carries no principal', async () => {
  const { commentsService } = await import('../services/comments.js')

  const comment = await commentsService.reply(
    { threadId: 1, body: 'Noted.' },
    { kind: 'agent', name: 'Codex', label: null, session: 'bbbb2222' }
  )

  const written = raw.prepare('SELECT author_id FROM comments WHERE id = ?').get(comment.id) as {
    author_id: number | null
  }
  assert.equal(written.author_id, null)
})

test('reopening the database mints no second principal and rewrites nothing', async () => {
  const { getDatabase, closeDatabase } = await import('../db/client.js')
  const { resetInstanceIdCache } = await import('../instance.js')

  const attributionBefore = comments().map((row) => [row.id, row.author_id])

  closeDatabase()
  resetInstanceIdCache()
  getDatabase()

  assert.equal(principals().length, 1)
  assert.deepEqual(
    comments().map((row) => [row.id, row.author_id]),
    attributionBefore
  )
})
