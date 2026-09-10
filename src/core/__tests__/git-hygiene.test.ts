/**
 * Refs are refs, and paths stay inside the checkout.
 *
 * Neither of these is a security boundary today - every caller of this app is
 * its owner - and the tests are written accordingly: they check that a value
 * which is not a ref is *refused* rather than handed to git, and that a path
 * which addresses its way out of a worktree reads nothing. The point is that
 * both hold before refs and paths start arriving over a carrier from another
 * machine, which is when they stop being hygiene.
 *
 * The other half of the job is the one that is easy to forget: none of this may
 * reject anything that works today. `HEAD~1`, `feature/x` and a raw sha are all
 * things a user or an agent can legitimately have put in a review, and each has
 * a case below.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-hygiene-'))

const { resolveCompare, readReviewFile, readReviewImage, resolveReviewFilePath } = await import(
  '../git-compare.js'
)
const { isValidRef, resetRefValidationCache } = await import('../git-refs.js')
const { AppError } = await import('../../shared/errors.js')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

let checkout: string
let headSha: string

before(() => {
  checkout = join(workDir, 'project')
  mkdirSync(checkout, { recursive: true })
  git(checkout, 'init', '-b', 'main')
  git(checkout, 'config', 'user.email', 'test@example.com')
  git(checkout, 'config', 'user.name', 'Test')

  writeFileSync(join(checkout, 'app.ts'), 'const a = 1\n')
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'first')

  writeFileSync(join(checkout, 'app.ts'), 'const a = 1\nconst b = 2\n')
  git(checkout, 'commit', '-am', 'second')
  headSha = git(checkout, 'rev-parse', 'HEAD')

  git(checkout, 'branch', 'feature/x')

  // A file the app has no business reading, one level above the checkout.
  writeFileSync(join(workDir, 'secret.txt'), 'not part of any repository\n')
})

after(() => rmSync(workDir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// What a ref may be
// ---------------------------------------------------------------------------

test('the refs people actually use are all accepted', async () => {
  for (const ref of [
    'main',
    'HEAD',
    'feature/x',
    'HEAD~1',
    'main^',
    'main^2',
    'HEAD~2^{commit}',
    'main@{upstream}',
    headSha,
    headSha.slice(0, 8),
    'refs/heads/main'
  ]) {
    assert.equal(await isValidRef(ref, checkout), true, ref)
  }
})

test('a value that is not a ref name is refused', async () => {
  for (const ref of [
    '',
    ' ',
    '-oops',
    '--upload-pack=touch /tmp/pwned',
    'main..other',
    'main~~..',
    'a ref with spaces',
    'refs/heads/main.lock',
    'refs/heads/.hidden',
    'has\ttab',
    'has\u0000nul',
    'has\nnewline',
    '~1',
    '^'
  ]) {
    assert.equal(await isValidRef(ref, checkout), false, JSON.stringify(ref))
  }
})

test('the answer is cached, and clearing the cache does not change it', async () => {
  assert.equal(await isValidRef('main', checkout), true)
  assert.equal(await isValidRef('main', checkout), true)

  resetRefValidationCache()
  assert.equal(await isValidRef('main', checkout), true)
  assert.equal(await isValidRef('-oops', checkout), false)
})

// ---------------------------------------------------------------------------
// What that means for a review
// ---------------------------------------------------------------------------

test('a review on ordinary refs still resolves', async () => {
  const compare = await resolveCompare(checkout, 'main', 'feature/x')

  assert.equal(compare.error, null)
  assert.equal(compare.base.sha, headSha)
  assert.equal(compare.head.sha, headSha)
})

test('a relative revision still resolves, because it always did', async () => {
  const compare = await resolveCompare(checkout, 'HEAD~1', 'main')

  assert.equal(compare.base.error, null)
  assert.equal(compare.base.sha, git(checkout, 'rev-parse', 'HEAD~1'))
})

test('an option pretending to be a ref is reported, not run', async () => {
  const compare = await resolveCompare(checkout, '--upload-pack=touch /tmp/pwned', 'main')

  assert.match(compare.base.error ?? '', /not a valid ref name/)
  assert.equal(compare.base.sha, null)
  // The other endpoint is unaffected: one bad ref does not poison the review.
  assert.equal(compare.head.error, null)
})

test('a ref that no longer exists is still reported as missing, not as invalid', async () => {
  // The distinction matters to a user: a deleted branch is a normal state and
  // reads differently from a typo that was never a name at all.
  const compare = await resolveCompare(checkout, 'main', 'branch-that-went-away')

  assert.match(compare.head.error ?? '', /does not resolve to a commit/)
})

// ---------------------------------------------------------------------------
// Where a file may come from
// ---------------------------------------------------------------------------

test('a file in the checkout reads normally', async () => {
  const content = await readReviewFile(checkout, 'main', 'main', 'app.ts', { changes: 'all' })

  assert.equal(content.error, null)
  assert.deepEqual(content.lines, ['const a = 1', 'const b = 2'])
})

test('a path that climbs out of the worktree reads nothing', async () => {
  for (const path of ['../secret.txt', '../../secret.txt', 'src/../../secret.txt']) {
    const content = await readReviewFile(checkout, 'main', 'main', path, { changes: 'all' })
    assert.equal(content.lines.length, 0, path)
    assert.match(content.error ?? '', /not a path inside this repository/, path)
  }
})

test('an absolute path is not a path inside the repository either', async () => {
  const content = await readReviewFile(checkout, 'main', 'main', join(workDir, 'secret.txt'), {
    changes: 'all'
  })

  assert.equal(content.lines.length, 0)
  assert.match(content.error ?? '', /not a path inside this repository/)
})

test('the same rule applies to images', async () => {
  const image = await readReviewImage(checkout, 'main', 'main', '../secret.png', 'head', {
    changes: 'all'
  })

  assert.equal(image.dataUrl, null)
  assert.match(image.error ?? '', /not a path inside this repository/)
})

test('and to the path handed to an editor', async () => {
  await assert.rejects(
    () => resolveReviewFilePath(checkout, 'main', 'main', '../secret.txt', { changes: 'all' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT'
  )
})
