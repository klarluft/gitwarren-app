/**
 * What a machine says about its own folders.
 *
 * Against a real filesystem, because every claim here is one about the
 * filesystem: that a symlink to a file is not a folder, that `~` means the
 * answering machine's home, that a missing path and an empty one are different
 * answers. A fake would let all four pass while the real thing did something
 * else on the one platform nobody tested.
 *
 * The property that matters most is at the end. The whole point of `fs.list` is
 * that the machine holding the files answers, and a person on a Mac browsing a
 * Linux host has no way to check what they were told - so a listing that
 * quietly dropped rows would be indistinguishable from a folder that did not
 * contain what they were looking for.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-fs-data-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { fsService, MAX_ENTRIES } = await import('../fs.js')
const { AppError } = await import('../../../shared/errors.js')

const root = mkdtempSync(join(tmpdir(), 'gitwarren-fs-'))

before(() => {
  mkdirSync(join(root, 'plain'))
  mkdirSync(join(root, '.hidden'))
  mkdirSync(join(root, 'a-repository', '.git'), { recursive: true })
  // A worktree or a submodule spells `.git` as a file, and is just as much a
  // repository. Both shapes have to be recognised or half of the badges are
  // missing on exactly the machines where checking by hand is hardest.
  mkdirSync(join(root, 'a-worktree'))
  writeFileSync(join(root, 'a-worktree', '.git'), 'gitdir: /elsewhere\n')
  writeFileSync(join(root, 'a-file.txt'), 'not a folder\n')
  symlinkSync(join(root, 'a-file.txt'), join(root, 'link-to-file'))
  symlinkSync(join(root, 'plain'), join(root, 'link-to-folder'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

async function names(path?: string): Promise<string[]> {
  const listing = await fsService.list(path === undefined ? {} : { path })
  return listing.entries.map((entry) => entry.name)
}

async function expectError(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  throw new Error(`expected the call to reject with ${code}`)
}

test('folders are listed and files are not', async () => {
  const listed = await names(root)

  assert.ok(listed.includes('plain'))
  assert.ok(listed.includes('a-repository'))
  assert.ok(!listed.includes('a-file.txt'), 'a file is never the answer to "which repository"')
})

test('a symlink counts as what it points at', async () => {
  const listed = await names(root)

  assert.ok(listed.includes('link-to-folder'), 'a link to a folder is a way into that folder')
  assert.ok(!listed.includes('link-to-file'), 'a link to a file is still a file')
})

test('both spellings of a repository are marked', async () => {
  const listing = await fsService.list({ path: root })
  const marked = listing.entries.filter((entry) => entry.isRepository).map((entry) => entry.name)

  assert.deepEqual(marked.sort(), ['a-repository', 'a-worktree'])
})

test('hidden folders are listed and flagged, never filtered out', async () => {
  const listing = await fsService.list({ path: root })
  const hidden = listing.entries.find((entry) => entry.name === '.hidden')

  // Dotfile repositories are a real thing people review, so the decision about
  // whether to show these belongs to the screen. A listing that dropped rows
  // would be one you could not trust when what you wanted was not in it.
  assert.ok(hidden, '.hidden should be in the listing')
  assert.equal(hidden.isHidden, true)
  assert.equal(listing.entries.find((entry) => entry.name === 'plain')?.isHidden, false)
})

test('entries carry the absolute path, which is what gets stored', async () => {
  const listing = await fsService.list({ path: root })
  const plain = listing.entries.find((entry) => entry.name === 'plain')

  assert.equal(plain?.path, join(root, 'plain'))
})

test('no path at all means home, and the separator says whose filesystem this is', async () => {
  const listing = await fsService.list({})

  assert.equal(listing.path, homedir())
  assert.equal(listing.home, homedir())
  // The one field a Mac driving a Linux host cannot work out for itself.
  assert.equal(listing.separator, sep)
})

test('a leading ~ is expanded by whoever answers', async () => {
  // Which is the point of it: someone adding a repository on `pc-wsl` knows it
  // is under `~/github.com` and has no reason to know that `~` is `/home/xfor`
  // over there.
  const listing = await fsService.list({ path: '~' })

  assert.equal(listing.path, homedir())
})

test('a ~ in the middle is part of a folder name, not a home directory', async () => {
  await expectError('PATH_NOT_FOUND', () => fsService.list({ path: join(root, 'no~such') }))
})

test('the way up, and the fact that there is not one at the root', async () => {
  const inside = await fsService.list({ path: join(root, 'plain') })
  assert.equal(inside.parent, root)

  const top = await fsService.list({ path: sep })
  assert.equal(top.parent, null, 'null is how the screen knows to stop offering "Up"')
})

test('a missing folder and an empty one are different answers', async () => {
  const empty = await fsService.list({ path: join(root, 'plain') })
  assert.deepEqual(empty.entries, [])
  assert.equal(empty.truncated, false)

  await expectError('PATH_NOT_FOUND', () => fsService.list({ path: join(root, 'nope') }))
})

test('a file is refused as a folder, and says which it is', async () => {
  await expectError('INVALID_INPUT', () => fsService.list({ path: join(root, 'a-file.txt') }))
})

test('a relative path is refused rather than resolved against the daemon cwd', async () => {
  // The cwd of a daemon spawned over `ssh` is whatever the login shell left it
  // as, which is not something a caller on another machine can reason about.
  await expectError('INVALID_INPUT', () => fsService.list({ path: 'relative/path' }))
})

test('a very large folder is cut short, and says so', async () => {
  const many = join(root, 'many')
  mkdirSync(many)
  for (let index = 0; index < MAX_ENTRIES + 5; index += 1) {
    mkdirSync(join(many, `folder-${String(index).padStart(4, '0')}`))
  }

  const listing = await fsService.list({ path: many })
  assert.equal(listing.entries.length, MAX_ENTRIES)
  // The flag is what lets the screen keep the text field honest: the folder
  // someone wants may be one of the ones not shown.
  assert.equal(listing.truncated, true)
})
