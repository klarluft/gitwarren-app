/**
 * Integration coverage for the shared service layer.
 *
 * These exercise the real SQLite file and real `git` binary against throwaway
 * directories - the behaviour worth protecting (root resolution, deduplication,
 * live state) only shows up when those are real.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { sql } from 'drizzle-orm'

// The modules themselves are imported dynamically below (after the env var is
// set), so the type has to be pulled in separately.
import type { AppError as AppErrorInstance } from '../../shared/errors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-work-'))
process.env.GITWARREN_DATA_DIR = dataDir

// Imported after the env var is set so the connection opens against the
// throwaway directory rather than the real application-data location.
const { repositoriesService } = await import('../services/repositories.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { repositories } = await import('../db/schema.js')
const { AppError } = await import('../../shared/errors.js')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo(name: string): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  return root
}

function commit(root: string): void {
  writeFileSync(join(root, 'README.md'), '# test\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'initial')
}

async function expectError(code: string, fn: () => Promise<unknown>): Promise<AppErrorInstance> {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  throw new Error(`expected the call to reject with ${code}`)
}

let repoA: string
let repoB: string

before(() => {
  repoA = makeRepo('alpha')
  commit(repoA)
  repoB = makeRepo('beta')
})

beforeEach(() => {
  getDatabase().delete(repositories).run()
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

test('migrations run automatically on first connection', () => {
  const tables = getDatabase().all<{ name: string }>(
    sql`select name from sqlite_master where type='table'`
  )
  assert.ok(tables.some((t) => t.name === 'repositories'))
})

test('add stores the repository root and defaults the name to the folder', async () => {
  const repo = await repositoriesService.add({ path: repoA })
  assert.equal(repo.name, 'alpha')
  assert.ok(repo.path.endsWith('alpha'))
})

test('a subdirectory resolves to the same root, so it cannot be added twice', async () => {
  const first = await repositoriesService.add({ path: repoA })
  const nested = join(repoA, 'src', 'deep')
  mkdirSync(nested, { recursive: true })

  const error = await expectError('DUPLICATE_REPOSITORY', () =>
    repositoriesService.add({ path: nested })
  )
  assert.match(error.message, /already tracked/i)

  const all = await repositoriesService.list()
  assert.equal(all.length, 1)
  assert.equal(all[0]?.id, first.id)
})

test('a non-git directory is rejected', async () => {
  const plain = join(workDir, 'not-a-repo')
  mkdirSync(plain, { recursive: true })
  await expectError('NOT_A_GIT_REPOSITORY', () => repositoriesService.add({ path: plain }))
})

test('a path that does not exist is rejected', async () => {
  await expectError('PATH_NOT_FOUND', () =>
    repositoriesService.add({ path: join(workDir, 'nope') })
  )
})

test('invalid input is rejected with field errors', async () => {
  const error = await expectError('INVALID_INPUT', () => repositoriesService.add({ path: '   ' }))
  assert.ok(error.fieldErrors?.path)
})

test('list reports live git state without persisting it', async () => {
  await repositoriesService.add({ path: repoA })
  const [repo] = await repositoriesService.list()
  assert.ok(repo)
  assert.equal(repo.git.exists, true)
  assert.equal(repo.git.isGitRepository, true)
  assert.equal(repo.git.branch, 'main')
  assert.equal(repo.git.isEmpty, false)

  // The stored row carries no git columns at all.
  const row = getDatabase().select().from(repositories).get()
  assert.ok(row && !('branch' in row))
})

test('a repository with no commits still reports its branch', async () => {
  await repositoriesService.add({ path: repoB })
  const [repo] = await repositoriesService.list()
  assert.equal(repo?.git.branch, 'main')
  assert.equal(repo?.git.isEmpty, true)
})

test('a deleted working copy is reported, not thrown', async () => {
  const gone = makeRepo('vanishing')
  const added = await repositoriesService.add({ path: gone })
  rmSync(gone, { recursive: true, force: true })

  const repo = await repositoriesService.get({ id: added.id })
  assert.equal(repo.git.exists, false)
  assert.equal(repo.git.branch, null)
  assert.match(repo.git.error ?? '', /no longer exists/i)
})

test('update renames and bumps updatedAt', async () => {
  const added = await repositoriesService.add({ path: repoA })
  const renamed = await repositoriesService.update({ id: added.id, name: 'Alpha Project' })
  assert.equal(renamed.name, 'Alpha Project')
  assert.ok(renamed.updatedAt >= added.updatedAt)
})

test('update rejects a path that another entry already tracks', async () => {
  await repositoriesService.add({ path: repoA })
  const second = await repositoriesService.add({ path: repoB })
  await expectError('DUPLICATE_REPOSITORY', () =>
    repositoriesService.update({ id: second.id, path: repoA })
  )
})

test('update requires at least one field', async () => {
  const added = await repositoriesService.add({ path: repoA })
  await expectError('INVALID_INPUT', () => repositoriesService.update({ id: added.id }))
})

test('remove deletes the row and is reported when missing', async () => {
  const added = await repositoriesService.add({ path: repoA })
  assert.deepEqual(await repositoriesService.remove({ id: added.id }), { id: added.id })
  assert.equal((await repositoriesService.list()).length, 0)
  await expectError('NOT_FOUND', () => repositoriesService.remove({ id: added.id }))
})

test('get reports a missing id', async () => {
  await expectError('NOT_FOUND', () => repositoriesService.get({ id: 4242 }))
})
