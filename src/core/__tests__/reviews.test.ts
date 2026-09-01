/**
 * Integration coverage for reviews.
 *
 * The setup deliberately puts the head branch in a *linked worktree* rather
 * than in the checkout that was added to GitWarren, because that is the case
 * the feature exists for and the one a simpler implementation gets wrong: the
 * repository row points at one directory, and the work under review is sitting
 * uncommitted in another.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../shared/errors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-review-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-review-work-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { repositoriesService } = await import('../services/repositories.js')
const { reviewsService } = await import('../services/reviews.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { repositories, reviews } = await import('../db/schema.js')
const { AppError } = await import('../../shared/errors.js')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, path: string, contents: string): void {
  writeFileSync(join(root, path), contents)
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

/** The checkout registered with GitWarren; `main` lives here. */
let mainCheckout: string
/** A linked worktree holding `feature` - where the uncommitted work is. */
let featureWorktree: string
let repositoryId: number

before(() => {
  mainCheckout = join(workDir, 'project')
  mkdirSync(mainCheckout, { recursive: true })
  git(mainCheckout, 'init', '-b', 'main')
  git(mainCheckout, 'config', 'user.email', 'test@example.com')
  git(mainCheckout, 'config', 'user.name', 'Test')

  write(mainCheckout, '.gitignore', '*.log\n')
  write(mainCheckout, 'a.txt', 'one\ntwo\nthree\n')
  git(mainCheckout, 'add', '.')
  git(mainCheckout, 'commit', '-m', 'initial')

  // `feature` is created straight into a linked worktree, so it is never
  // checked out in the directory GitWarren tracks.
  featureWorktree = join(workDir, 'feature-worktree')
  git(mainCheckout, 'worktree', 'add', featureWorktree, '-b', 'feature')

  write(featureWorktree, 'a.txt', 'one\nTWO\nthree\n')
  write(featureWorktree, 'b.txt', 'committed addition\n')
  git(featureWorktree, 'add', '.')
  git(featureWorktree, 'commit', '-m', 'feature work')

  // Now the part that is not committed anywhere.
  write(featureWorktree, 'a.txt', 'one\nTWO\nthree\nfour (uncommitted)\n')
  write(featureWorktree, 'staged.txt', 'staged addition\n')
  git(featureWorktree, 'add', 'staged.txt')
  write(featureWorktree, 'untracked.txt', 'brand new\n')
  write(featureWorktree, 'noise.log', 'should be ignored\n')
})

beforeEach(async () => {
  getDatabase().delete(reviews).run()
  getDatabase().delete(repositories).run()
  const repository = await repositoriesService.add({ path: mainCheckout })
  repositoryId = repository.id
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

async function createReview(): Promise<number> {
  const review = await reviewsService.create({
    repositoryId,
    baseRef: 'main',
    headRef: 'feature'
  })
  return review.id
}

test('a review stores its refs and defaults its title from them', async () => {
  const review = await reviewsService.create({
    repositoryId,
    baseRef: 'main',
    headRef: 'feature'
  })

  assert.equal(review.baseRef, 'main')
  assert.equal(review.headRef, 'feature')
  assert.equal(review.title, 'feature into main')
  assert.equal(review.status, 'open')
  assert.equal(review.closedAt, null)
})

test('creating a review against a ref that does not exist is a field error', async () => {
  const error = await expectError('INVALID_INPUT', () =>
    reviewsService.create({ repositoryId, baseRef: 'main', headRef: 'no-such-branch' })
  )
  assert.ok(error.fieldErrors?.headRef)
})

test('a ref cannot be compared against itself', async () => {
  await expectError('INVALID_INPUT', () =>
    reviewsService.create({ repositoryId, baseRef: 'main', headRef: 'main' })
  )
})

test('the commits tab lists what head added, and finds the uncommitted work', async () => {
  const id = await createReview()
  const result = await reviewsService.commits({ id })

  assert.equal(result.error, null)
  assert.equal(result.commits.length, 1)
  assert.equal(result.commits[0]?.subject, 'feature work')

  // The point of the exercise: the dirty state was found in the linked
  // worktree, not in the directory the repository row points at.
  assert.ok(result.headWorktree, 'expected a worktree holding the head branch')
  assert.equal(result.headWorktree?.branch, 'feature')
  assert.notEqual(result.headWorktree?.path, mainCheckout)

  const workingTree = result.workingTree
  assert.ok(workingTree)
  assert.equal(workingTree.isDirty, true)
  assert.equal(workingTree.staged, 1) // staged.txt
  assert.equal(workingTree.unstaged, 1) // a.txt
  assert.equal(workingTree.untracked, 1) // untracked.txt, but not noise.log
})

test('the diff folds uncommitted work in, and leaves ignored files out', async () => {
  const id = await createReview()
  const diff = await reviewsService.diff({ id, includeUncommitted: true })

  assert.equal(diff.error, null)
  assert.equal(diff.includedUncommitted, true)

  const paths = diff.files.map((file) => file.path).sort()
  assert.deepEqual(paths, ['a.txt', 'b.txt', 'staged.txt', 'untracked.txt'])
  assert.ok(!paths.includes('noise.log'), '.gitignore should still apply')

  const a = diff.files.find((file) => file.path === 'a.txt')
  assert.equal(a?.status, 'modified')
  // Both the committed edit and the uncommitted one are in the same patch.
  assert.equal(a?.hasUncommittedChanges, true)
  assert.ok(
    a?.hunks.some((hunk) =>
      hunk.lines.some((line) => line.type === 'insert' && line.content.includes('uncommitted'))
    ),
    'the uncommitted line should appear as an addition'
  )

  const untracked = diff.files.find((file) => file.path === 'untracked.txt')
  assert.equal(untracked?.status, 'added')
  assert.equal(untracked?.isUntracked, true)
  assert.equal(untracked?.additions, 1)

  const b = diff.files.find((file) => file.path === 'b.txt')
  assert.equal(b?.status, 'added')
  assert.equal(b?.hasUncommittedChanges, false, 'b.txt was committed')
})

test('uncommitted work can be excluded, leaving the committed diff', async () => {
  const id = await createReview()
  const diff = await reviewsService.diff({ id, includeUncommitted: false })

  assert.equal(diff.includedUncommitted, false)
  const paths = diff.files.map((file) => file.path).sort()
  assert.deepEqual(paths, ['a.txt', 'b.txt'])

  const a = diff.files.find((file) => file.path === 'a.txt')
  assert.ok(
    !a?.hunks.some((hunk) =>
      hunk.lines.some((line) => line.content.includes('uncommitted'))
    ),
    'the uncommitted line must not leak into the committed-only diff'
  )

  // The dirty state is still reported, so the UI can offer to include it.
  assert.equal(diff.workingTree?.isDirty, true)
})

test('a file can be read whole, from the worktree, to expand the diff', async () => {
  const id = await createReview()
  const content = await reviewsService.file({ id, path: 'a.txt', includeUncommitted: true })

  assert.equal(content.error, null)
  assert.equal(content.source, 'worktree')
  assert.equal(content.isBinary, false)
  // The uncommitted fourth line is there, because that is the version of the
  // file the diff on screen was taken from.
  assert.deepEqual(content.lines, ['one', 'TWO', 'three', 'four (uncommitted)'])
})

test('excluding uncommitted work reads the committed blob instead', async () => {
  const id = await createReview()
  const content = await reviewsService.file({ id, path: 'a.txt', includeUncommitted: false })

  assert.equal(content.error, null)
  assert.equal(content.source, 'commit')
  assert.deepEqual(content.lines, ['one', 'TWO', 'three'])
})

test('a file outside the repository is refused rather than read', async () => {
  const id = await createReview()
  const content = await reviewsService.file({ id, path: '../../../etc/hosts' })

  assert.ok(content.error)
  assert.deepEqual(content.lines, [])
})

test('a file that is in no commit and on no disk reports why', async () => {
  const id = await createReview()
  const content = await reviewsService.file({ id, path: 'nothing-here.txt' })

  assert.ok(content.error, 'a missing file should be reported, not thrown')
})

test('the absolute path of a file points into the worktree holding the head', async () => {
  const id = await createReview()
  const absolute = await reviewsService.absolutePath({ id, path: 'a.txt' })

  // Compared by suffix: git reports the worktree by its canonical path, and on
  // macOS the temporary directory reaches it through a `/var` symlink.
  assert.ok(
    absolute.endsWith(join('feature-worktree', 'a.txt')),
    `expected a path in the feature worktree, got ${absolute}`
  )
  assert.ok(!absolute.includes(join('project', 'a.txt')), 'not the tracked checkout')
})

test('there is no absolute path for a file that only exists in a commit', async () => {
  const id = await createReview()
  await expectError('PATH_NOT_FOUND', () =>
    reviewsService.absolutePath({ id, path: 'nothing-here.txt' })
  )
})

test('a path trying to escape the repository never reaches the filesystem', async () => {
  const id = await createReview()
  await expectError('INVALID_INPUT', () =>
    reviewsService.absolutePath({ id, path: '../outside.txt' })
  )
})

test('refs report where a branch is checked out and whether it is dirty', async () => {
  const result = await repositoriesService.refs({ id: repositoryId })

  assert.equal(result.error, null)
  assert.equal(result.defaultBranch, 'main')
  assert.equal(result.currentBranch, 'main')
  assert.equal(result.worktrees.length, 2)

  const feature = result.refs.find((ref) => ref.name === 'feature')
  assert.ok(feature)
  assert.equal(feature.kind, 'local-branch')
  assert.equal(feature.checkedOutAt !== null, true)
  assert.equal(feature.hasUncommittedChanges, true)

  const main = result.refs.find((ref) => ref.name === 'main')
  assert.equal(main?.hasUncommittedChanges, false)
})

test('closing a review stamps closedAt, reopening clears it', async () => {
  const id = await createReview()

  const closed = await reviewsService.update({ id, status: 'closed' })
  assert.equal(closed.status, 'closed')
  assert.ok(closed.closedAt)

  const reopened = await reviewsService.update({ id, status: 'open' })
  assert.equal(reopened.status, 'open')
  assert.equal(reopened.closedAt, null)
})

test('reviews can be filtered by repository and status', async () => {
  const first = await createReview()
  await reviewsService.update({ id: first, status: 'closed' })
  await reviewsService.create({ repositoryId, baseRef: 'main', headRef: 'feature', title: 'Second' })

  assert.equal((await reviewsService.list({ repositoryId })).length, 2)
  assert.equal((await reviewsService.list({ repositoryId, status: 'open' })).length, 1)
  assert.equal((await reviewsService.list({ repositoryId, status: 'closed' })).length, 1)
  assert.equal((await reviewsService.list({})).length, 2)
})

test('removing a repository takes its reviews with it', async () => {
  const id = await createReview()
  await repositoriesService.remove({ id: repositoryId })

  await expectError('NOT_FOUND', () => reviewsService.get({ id }))
  assert.equal((await reviewsService.list({})).length, 0)
})

test('a review survives its branch being deleted, and says so', async () => {
  const review = await reviewsService.create({
    repositoryId,
    baseRef: 'main',
    headRef: 'feature',
    title: 'Doomed'
  })

  // Point the review at a branch, then delete it out from under the app.
  git(mainCheckout, 'branch', 'temporary', 'main')
  await reviewsService.update({ id: review.id, baseRef: 'temporary' })
  git(mainCheckout, 'branch', '-D', 'temporary')

  const result = await reviewsService.commits({ id: review.id })
  assert.ok(result.base.error, 'the missing ref should be reported, not thrown')
  assert.equal(result.commits.length, 0)
  // The review row itself is untouched and still editable.
  assert.equal((await reviewsService.get({ id: review.id })).title, 'Doomed')
})
