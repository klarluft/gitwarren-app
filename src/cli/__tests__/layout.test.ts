/**
 * Which install this is, which is the question `update` and `uninstall` both
 * start from.
 *
 * Every answer here turns on where one file is, so these are paths and
 * nothing else - four of the five kinds are not even on this machine. The
 * property worth protecting is not that the names come out right: it is that
 * `selfUpdatable` is true for exactly one of them. Everything this feature
 * could do wrong - writing over a Homebrew Cellar, deleting a project's
 * `node_modules`, removing a git worktree - is one of these branches saying
 * "managed" when it should not.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { describeLayout, formatBytes, isInside, listDaemonDirectories } from '../layout.js'

let home: string
const realHome = process.env.HOME
const realProfile = process.env.USERPROFILE

before(() => {
  home = mkdtempSync(join(tmpdir(), 'gitwarren-layout-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})

after(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realProfile
  rmSync(home, { recursive: true, force: true })
})

/** A layout for a `gitwarren` whose bundle is at `script`. */
function layoutFor(script: string | null): ReturnType<typeof describeLayout> {
  return describeLayout('0.1.14', { script, mcpServer: null })
}

test('an install under ~/.gitwarren/daemon is the one this can replace', () => {
  const layout = layoutFor(join(home, '.gitwarren', 'daemon', '0.1.14', 'lib', 'gitwarren.cjs'))

  assert.equal(layout.kind, 'managed')
  assert.equal(layout.selfUpdatable, true)
  assert.equal(layout.prefix, join(home, '.gitwarren', 'daemon', '0.1.14'))
  assert.equal(layout.updateWith, null)
  assert.equal(layout.removeWith, null)
})

test('Homebrew, npm and npx are named rather than written over', () => {
  const brew = layoutFor('/opt/homebrew/Cellar/gitwarren-cli/0.1.14/libexec/lib/gitwarren.cjs')
  assert.equal(brew.kind, 'homebrew')
  assert.equal(brew.selfUpdatable, false)
  assert.match(brew.updateWith ?? '', /brew upgrade gitwarren-cli/)
  assert.match(brew.removeWith ?? '', /brew uninstall gitwarren-cli/)

  const npx = layoutFor(join(home, '.npm', '_npx', 'ab12', 'node_modules', 'gitwarren', 'bin', 'gitwarren.mjs'))
  assert.equal(npx.kind, 'npx')
  assert.equal(npx.selfUpdatable, false)

  // `_npx` is checked before `node_modules`, because every npx copy is inside
  // one of those too and the advice for the two is not the same.
  const npm = layoutFor('/srv/project/node_modules/gitwarren/bin/gitwarren.mjs')
  assert.equal(npm.kind, 'npm')
  assert.equal(npm.selfUpdatable, false)
})

test('a source checkout owns nothing at all', () => {
  // `script` is null under tsx - `node` cannot run a .ts file - and that is
  // also the signal that there is no install here to act on. `prefix` being
  // null is what makes every launcher somebody else's in `launchers.ts`.
  const layout = layoutFor(null)

  assert.equal(layout.kind, 'checkout')
  assert.equal(layout.selfUpdatable, false)
  assert.equal(layout.prefix, null)
})

test('a tarball unpacked somewhere else is recognised, and still not ours to replace', () => {
  const prefix = join(home, 'opt', 'gitwarren')
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  mkdirSync(join(prefix, 'lib'), { recursive: true })
  writeFileSync(join(prefix, 'bin', 'gitwarren'), '#!/bin/sh\n')

  const layout = layoutFor(join(prefix, 'lib', 'gitwarren.cjs'))

  assert.equal(layout.kind, 'tarball')
  // Unpacked by hand into a directory of the user's choosing, which may be one
  // this process cannot write to and is certainly not one it should guess at.
  assert.equal(layout.selfUpdatable, false)
})

test('isInside is about paths, not about string prefixes', () => {
  assert.equal(isInside('/a/b/c', '/a/b'), true)
  assert.equal(isInside('/a/bc', '/a/b'), false)
  assert.equal(isInside('/a/b', '/a/b'), false)
  assert.equal(isInside('/a', '/a/b'), false)
})

test('the daemon directory lists versions, and marks a scratch directory unrunnable', () => {
  const daemonRoot = join(home, '.gitwarren', 'daemon')
  for (const version of ['0.1.9', '0.1.10']) {
    mkdirSync(join(daemonRoot, version, 'bin'), { recursive: true })
    mkdirSync(join(daemonRoot, version, 'lib'), { recursive: true })
    writeFileSync(join(daemonRoot, version, 'bin', 'gitwarren'), '#!/bin/sh\n')
  }
  mkdirSync(join(daemonRoot, '.install-999'), { recursive: true })

  const found = listDaemonDirectories(daemonRoot)

  // Numeric order, so 0.1.10 is after 0.1.9 rather than before it the way a
  // plain string sort would have it.
  assert.deepEqual(
    found.map((directory) => directory.version),
    ['.install-999', '0.1.9', '0.1.10']
  )
  assert.equal(found.find((directory) => directory.version === '.install-999')?.runnable, false)
  assert.equal(found.find((directory) => directory.version === '0.1.10')?.runnable, true)
})

test('listing a daemon directory that is not there is empty, not a throw', () => {
  assert.deepEqual(listDaemonDirectories(join(home, 'nowhere')), [])
})

test('bytes are rounded the way a person reads them', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(45 * 1024 * 1024), '45 MB')
})
