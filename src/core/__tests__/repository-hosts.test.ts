/**
 * One repository per path, per host.
 *
 * `UNIQUE(path)` has always been the backstop that stops the same repository
 * being tracked twice. M0 replaces it with a pair of indexes so that a path can
 * repeat across hosts - the same string names different code inside a WSL
 * distro than it does on the laptop - without local rows losing the guard they
 * had. The pair is easy to get subtly wrong, because SQLite treats NULLs in a
 * unique index as distinct from each other and NULL is exactly how a local row
 * is spelled, so both halves are pinned here.
 *
 * The assertions go through a second connection opened on the same file rather
 * than through the app's. What is being tested is the *database's* constraint,
 * and asking the database directly is the only way to be sure it is the index
 * answering rather than a check in a service.
 */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-hosts-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { getDatabase, closeDatabase } = await import('../db/client.js')
const { getDatabasePath } = await import('../paths.js')

let raw: Database.Database

before(() => {
  // Opening through the app first is what creates and migrates the file.
  getDatabase()
  raw = new Database(getDatabasePath())
})

after(() => {
  raw.close()
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
})

function insert(hostId: string | null, path: string): void {
  raw.prepare('INSERT INTO repositories (host_id, path, name) VALUES (?, ?, ?)').run(
    hostId,
    path,
    path
  )
}

function expectRejected(hostId: string | null, path: string): void {
  assert.throws(
    () => insert(hostId, path),
    (error: { code?: string }) => String(error.code).startsWith('SQLITE_CONSTRAINT'),
    `a second row for ${hostId ?? 'this host'}:${path} should have been refused`
  )
}

test('a local path cannot be tracked twice', () => {
  insert(null, '/work/app')
  expectRejected(null, '/work/app')
})

test('the same path on another host is a different repository', () => {
  insert('c0ffee00-0000-4000-8000-000000000001', '/work/app')
  insert('c0ffee00-0000-4000-8000-000000000002', '/work/app')

  const rows = raw
    .prepare('SELECT host_id FROM repositories WHERE path = ? ORDER BY id')
    .all('/work/app') as { host_id: string | null }[]

  assert.deepEqual(
    rows.map((row) => row.host_id),
    [null, 'c0ffee00-0000-4000-8000-000000000001', 'c0ffee00-0000-4000-8000-000000000002']
  )
})

test('nor can a path be tracked twice on the same remote host', () => {
  expectRejected('c0ffee00-0000-4000-8000-000000000001', '/work/app')
})

test('a different path on a host that already has one is fine', () => {
  insert('c0ffee00-0000-4000-8000-000000000001', '/work/other')
})
