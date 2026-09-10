/**
 * Coverage for the instance id.
 *
 * The id is about to be stamped on principals, repositories and links, so the
 * property that matters is not that it exists but that it never changes: a new
 * id after an upgrade or a crash would orphan every row that named the old one.
 * Hence the tests below are all about persistence and about what happens when
 * the file on disk is not what this code wrote.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-instance-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { getInstanceId, resetInstanceIdCache } = await import('../instance.js')
const { getInstanceIdPath } = await import('../paths.js')
const { isInstanceId } = await import('../../shared/instance-id.js')

after(() => rmSync(dataDir, { recursive: true, force: true }))

test('the id is a uuid, written to the data directory on first read', () => {
  const id = getInstanceId()

  assert.ok(isInstanceId(id), `${id} is not shaped like an instance id`)
  assert.equal(readFileSync(getInstanceIdPath(), 'utf8').trim(), id)
})

test('it is the same on every call, and across processes', () => {
  const first = getInstanceId()

  // Same process, cache warm.
  assert.equal(getInstanceId(), first)

  // A fresh process is a cold cache reading the same file.
  resetInstanceIdCache()
  assert.equal(getInstanceId(), first)
})

test('a file that is not an instance id is replaced rather than trusted', () => {
  writeFileSync(getInstanceIdPath(), 'not-a-uuid\n', 'utf8')
  resetInstanceIdCache()

  const id = getInstanceId()
  assert.ok(isInstanceId(id))
  assert.equal(readFileSync(getInstanceIdPath(), 'utf8').trim(), id)
})

test('trailing whitespace in the file is not part of the id', () => {
  const id = getInstanceId()
  writeFileSync(getInstanceIdPath(), `  ${id}  \n\n`, 'utf8')
  resetInstanceIdCache()

  assert.equal(getInstanceId(), id)
})
