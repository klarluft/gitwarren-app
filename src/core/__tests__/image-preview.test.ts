/**
 * Coverage for showing an image in a diff instead of the words "binary file".
 *
 * Runs against a real repository with real PNGs in it, because the thing worth
 * proving is that the bytes survive the trip: a blob read as text and re-encoded
 * comes out corrupted, and the only way to notice is to compare it byte for byte
 * with what was committed.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { readReviewImage } from '../git-compare.js'
import { imageMediaType } from '../../shared/git.js'

/** 1×1 PNGs, one red and one blue - different bytes, both genuinely decodable. */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const BLUE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWpKrfwAAAABJRU5ErkJggg==',
  'base64'
)

const workDir = mkdtempSync(join(tmpdir(), 'gitwarren-image-'))
const repoPath = join(workDir, 'project')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** The image bytes back out of a `data:` URL, for comparing with the source. */
function decode(dataUrl: string): { mediaType: string; bytes: Buffer } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  assert.ok(match, `not a base64 data URL: ${dataUrl.slice(0, 40)}`)
  const [, mediaType = '', body = ''] = match
  return { mediaType, bytes: Buffer.from(body, 'base64') }
}

before(() => {
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main')
  git(repoPath, 'config', 'user.email', 'test@example.com')
  git(repoPath, 'config', 'user.name', 'Test')

  writeFileSync(join(repoPath, 'logo.png'), RED_PNG)
  writeFileSync(join(repoPath, 'notes.txt'), 'text\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'initial')

  git(repoPath, 'checkout', '-b', 'feature')
  // Changed on the head side, plus one that only exists there at all.
  writeFileSync(join(repoPath, 'logo.png'), BLUE_PNG)
  writeFileSync(join(repoPath, 'added.png'), BLUE_PNG)
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'new artwork')

  // And one that has not been committed anywhere, plus an uncommitted edit on
  // top of the committed change - which is what the `uncommitted` view is about.
  writeFileSync(join(repoPath, 'dirty.png'), RED_PNG)
  writeFileSync(join(repoPath, 'logo.png'), RED_PNG)
})

after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test('an extension decides whether a path is previewable', () => {
  assert.equal(imageMediaType('docs/logo.PNG'), 'image/png')
  assert.equal(imageMediaType('a/b.jpeg'), 'image/jpeg')
  assert.equal(imageMediaType('src/index.ts'), null)
  assert.equal(imageMediaType('icon.svg'), null, 'SVG has a real text diff already')
  assert.equal(imageMediaType('.png'), null, 'a dotfile is not an extension')
  assert.equal(imageMediaType('no-extension'), null)
})

test('both sides of a changed image come back, byte for byte', async () => {
  const base = await readReviewImage(repoPath, 'main', 'feature', 'logo.png', 'base', {
    changes: 'committed'
  })
  const head = await readReviewImage(repoPath, 'main', 'feature', 'logo.png', 'head', {
    changes: 'committed'
  })

  assert.equal(base.error, null)
  assert.equal(head.error, null)
  assert.equal(base.source, 'commit')

  const decodedBase = decode(base.dataUrl as string)
  const decodedHead = decode(head.dataUrl as string)
  assert.equal(decodedBase.mediaType, 'image/png')
  assert.ok(decodedBase.bytes.equals(RED_PNG), 'the base blob should survive the round trip')
  assert.ok(decodedHead.bytes.equals(BLUE_PNG), 'the head blob should survive the round trip')
  assert.equal(base.byteSize, RED_PNG.byteLength)
})

test('an image that exists only on the head side has no base to read', async () => {
  const base = await readReviewImage(repoPath, 'main', 'feature', 'added.png', 'base', {
    changes: 'committed'
  })

  assert.ok(base.error, 'a blob that is not in the merge base should be reported, not thrown')
  assert.equal(base.dataUrl, null)
})

test('uncommitted image work is read off disk, not from a commit', async () => {
  const head = await readReviewImage(repoPath, 'main', 'feature', 'dirty.png', 'head', {
    changes: 'all'
  })

  assert.equal(head.error, null)
  assert.equal(head.source, 'worktree')
  assert.ok(decode(head.dataUrl as string).bytes.equals(RED_PNG))
})

test('the uncommitted view measures "before" against the head commit', async () => {
  // The whole point of that view is the edit being made right now, so its base
  // is what was committed on the branch - not the merge base, which would put
  // the whole branch's artwork on screen as though it were part of this change.
  const base = await readReviewImage(repoPath, 'main', 'feature', 'logo.png', 'base', {
    changes: 'uncommitted'
  })
  const head = await readReviewImage(repoPath, 'main', 'feature', 'logo.png', 'head', {
    changes: 'uncommitted'
  })

  assert.equal(base.error, null)
  assert.equal(base.source, 'commit')
  assert.ok(decode(base.dataUrl as string).bytes.equals(BLUE_PNG), 'base is the head commit')
  assert.equal(head.source, 'worktree')
  assert.ok(decode(head.dataUrl as string).bytes.equals(RED_PNG))

  // The same file in the whole-branch view starts from the merge base instead.
  const wide = await readReviewImage(repoPath, 'main', 'feature', 'logo.png', 'base', {
    changes: 'all'
  })
  assert.ok(decode(wide.dataUrl as string).bytes.equals(RED_PNG), 'base is the merge base')
})

test('a path outside the repository is refused rather than read', async () => {
  const image = await readReviewImage(repoPath, 'main', 'feature', '../../secret.png', 'head', {
    changes: 'committed'
  })

  assert.ok(image.error)
  assert.equal(image.dataUrl, null)
})

test('a file that is not an image is refused before git is asked', async () => {
  const image = await readReviewImage(repoPath, 'main', 'feature', 'notes.txt', 'head', {
    changes: 'committed'
  })

  assert.ok(image.error)
  assert.equal(image.dataUrl, null)
})
