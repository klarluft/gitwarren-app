/**
 * The key two clones of one project are grouped by.
 *
 * M4.3 needs a way to say "the thing under `~/github.com` on `pc-wsl` and the
 * thing under `~/github.com` on this Mac are the same repository". Neither the
 * path nor the name can say it - two clones are usually in different places and
 * are often called something different - so the answer is the commit the
 * history starts at, which is the same forty characters everywhere.
 *
 * Against a real `git`, because every property being claimed here is `git`'s
 * and not this app's. The interesting one is the last test: a history that has
 * absorbed another project by merge has *two* roots, so the naive
 * `rev-list --max-parents=0` answers with a set - and a set is not a key. The
 * first-parent root is, and that is what makes a clone identifiable at all.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-root-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-root-work-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { readGitState } = await import('../git.js')

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(name: string): string {
  const root = join(workDir, name)
  mkdirSync(root, { recursive: true })
  run(root, 'init', '-b', 'main')
  run(root, 'config', 'user.email', 'test@example.com')
  run(root, 'config', 'user.name', 'Test')
  return root
}

function commit(root: string, message: string): void {
  writeFileSync(join(root, `${message}.txt`), `${message}\n`)
  run(root, 'add', '.')
  run(root, 'commit', '-m', message)
}

let origin: string

before(() => {
  origin = makeRepo('origin')
  commit(origin, 'first')
  commit(origin, 'second')
})

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

test('the root commit is the first commit, in full', async () => {
  const state = await readGitState(origin)
  const expected = run(origin, 'rev-list', '--max-parents=0', 'HEAD')

  assert.equal(state.rootCommit, expected)
  assert.match(state.rootCommit ?? '', /^[0-9a-f]{40}$/)
})

test('a clone in another place reports the same root', async () => {
  // What a repository on another machine actually is: a different path, a
  // different name, the same history. The grouping has to see through both.
  const clone = join(workDir, 'somewhere-else')
  execFileSync('git', ['clone', '--quiet', origin, clone], { cwd: workDir })

  const here = await readGitState(origin)
  const there = await readGitState(clone)

  assert.notEqual(origin, clone)
  assert.equal(there.rootCommit, here.rootCommit)
})

test('a repository with no commits has no root, and that is not a group', async () => {
  const empty = makeRepo('empty')
  const state = await readGitState(empty)

  assert.equal(state.isEmpty, true)
  // Null rather than a placeholder: two empty repositories are two empty
  // repositories, and a shared falsy key would collapse them into one.
  assert.equal(state.rootCommit, null)
})

test('a history that swallowed another project still has one root', async () => {
  const merged = makeRepo('merged')
  commit(merged, 'ours')
  const ourRoot = run(merged, 'rev-list', '--max-parents=0', 'HEAD')

  // A second, entirely unrelated history, merged in - a vendored project, or
  // two repositories joined years ago. `git` is perfectly happy with it.
  run(merged, 'remote', 'add', 'other', origin)
  run(merged, 'fetch', '--quiet', 'other')
  run(merged, 'merge', '--quiet', '--allow-unrelated-histories', '--no-edit', 'other/main')

  const allRoots = run(merged, 'rev-list', '--max-parents=0', 'HEAD').split('\n')
  assert.equal(allRoots.length, 2, 'the fixture should genuinely have two roots')

  const state = await readGitState(merged)
  // The first-parent root: where *this* project began, not where something it
  // later absorbed did. It is the half of the pair that is stable enough to be
  // a key.
  assert.equal(state.rootCommit, ourRoot)
})
