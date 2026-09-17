/**
 * `gitwarren update`, which is `install.sh` with two steps the script cannot
 * take.
 *
 * Three things are worth holding still here. The version comes from the
 * redirect `install.sh` reads, so the command and the script that installed it
 * cannot disagree about what "latest" means. A checksum that is present and
 * wrong stops everything, and one that is merely absent does not - a
 * development build has no formula, and refusing to update over that would
 * make the good case pay for the impossible one. And the install itself is
 * unpack-then-rename, so there is no moment at which
 * `~/.gitwarren/daemon/<version>` exists and cannot run.
 *
 * The last test is the whole command against a real tarball on a real disk,
 * because every mistake this code could make is a filesystem one.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { describeLayout } from '../layout.js'
import { applyUpdate, latestVersion, verifyChecksum } from '../update.js'

let home: string
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitwarren-update-'))
  // XDG_CONFIG_HOME as well as HOME: `service.ts` looks for the systemd unit
  // under it, and a test that left it pointing at the real one could restart
  // the developer's own GitWarren.
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME']) {
    saved.set(name, process.env[name])
    process.env[name] = name === 'XDG_CONFIG_HOME' ? join(home, '.config') : home
  }
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  rmSync(home, { recursive: true, force: true })
})

function answering(response: Partial<Response>): typeof fetch {
  return (() => Promise.resolve(response)) as unknown as typeof fetch
}

test('the newest version is the tag the releases/latest redirect lands on', async () => {
  const fetchImpl = answering({
    ok: true,
    url: 'https://github.com/klarluft/gitwarren-app/releases/tag/v0.1.15'
  })

  assert.equal(await latestVersion(fetchImpl), '0.1.15')
})

test('a redirect that does not land on a tag is a refusal, not a guess', async () => {
  // A captive portal, a proxy's error page, a repository with no releases:
  // all of them answer *something*, and none of them names a version.
  await assert.rejects(
    latestVersion(answering({ ok: true, url: 'https://example.com/login' })),
    /could not work out the newest release/
  )
})

test('a checksum that is present and wrong stops the install', async () => {
  const tarball = join(home, 'daemon.tar.gz')
  writeFileSync(tarball, 'not what the release built')

  const formula =
    'url "https://github.com/klarluft/gitwarren-app/releases/download/v0.1.15/' +
    'gitwarren-daemon-0.1.15-linux-x64.tar.gz"\n' +
    `      sha256 "${'0'.repeat(64)}"\n`

  await assert.rejects(
    verifyChecksum(
      tarball,
      '0.1.15',
      'linux-x64',
      answering({ ok: true, text: () => Promise.resolve(formula) })
    ),
    /did not match the checksum/
  )
})

test('a checksum that matches is checked, and one that is not published is not a failure', async () => {
  const tarball = join(home, 'daemon.tar.gz')
  writeFileSync(tarball, 'the bytes the release built')
  const sha = createHash('sha256').update('the bytes the release built').digest('hex')

  const formula =
    'url "https://github.com/klarluft/gitwarren-app/releases/download/v0.1.15/' +
    `gitwarren-daemon-0.1.15-linux-x64.tar.gz"\n      sha256 "${sha}"\n`

  assert.equal(
    await verifyChecksum(tarball, '0.1.15', 'linux-x64', answering({ ok: true, text: () => Promise.resolve(formula) })),
    'checked'
  )

  // No formula on the release - a development build, or a tarball staged
  // locally. HTTPS got the bytes here; refusing over a missing second file
  // would only stop the update that was going to work.
  assert.equal(
    await verifyChecksum(tarball, '0.1.15', 'linux-x64', answering({ ok: false, status: 404 })),
    'unavailable'
  )
})

/** A tarball shaped like the release's, whose `bin/gitwarren` runs and exits 0. */
function fakeTarball(version: string): string {
  const stage = mkdtempSync(join(tmpdir(), 'gitwarren-tarball-'))
  const root = join(stage, 'gitwarren-daemon')
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'gitwarren.cjs'), `// ${version}\n`)
  writeFileSync(join(root, 'bin', 'gitwarren'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(root, 'bin', 'gitwarren'), 0o755)

  const tarball = join(stage, `gitwarren-daemon-${version}-linux-x64.tar.gz`)
  execFileSync('tar', ['czf', tarball, '-C', stage, 'gitwarren-daemon'])
  return tarball
}

test(
  'an update unpacks into its own version directory and takes the old one with it',
  { skip: process.platform === 'win32' ? 'the tarball layout is POSIX-only; see release.ts' : false },
  () => {
    const daemonRoot = join(home, '.gitwarren', 'daemon')
    const previous = join(daemonRoot, '0.1.14')
    mkdirSync(join(previous, 'bin'), { recursive: true })
    mkdirSync(join(previous, 'lib'), { recursive: true })
    writeFileSync(join(previous, 'bin', 'gitwarren'), '#!/bin/sh\n')
    writeFileSync(join(previous, 'lib', 'gitwarren.cjs'), 'x'.repeat(4096))

    const layout = describeLayout('0.1.14', {
      script: join(previous, 'lib', 'gitwarren.cjs'),
      mcpServer: null
    })
    assert.equal(layout.selfUpdatable, true)

    const report = applyUpdate(layout, '0.1.15', fakeTarball('0.1.15'), 'linux-x64')

    assert.equal(report.destination, join(daemonRoot, '0.1.15'))
    assert.ok(existsSync(join(daemonRoot, '0.1.15', 'bin', 'gitwarren')))

    // The version that was replaced is gone rather than left to accumulate,
    // which is the thing no installer has ever done on any machine so far.
    assert.equal(existsSync(previous), false)
    assert.deepEqual(report.pruned.removed, ['0.1.14'])
    assert.ok(report.pruned.bytes >= 4096)

    // Nothing was registered to start at login under this HOME, so there is
    // nothing to restart - and an update must not start one.
    assert.equal(report.restarted, null)

    // No scratch directory left behind: an interrupted install leaves one, a
    // finished one must not.
    assert.deepEqual(
      execFileSync('ls', ['-A', daemonRoot], { encoding: 'utf8' }).trim().split('\n'),
      ['0.1.15']
    )
  }
)

test(
  'a tarball that unpacks into something that cannot run leaves the version directory alone',
  { skip: process.platform === 'win32' ? 'the tarball layout is POSIX-only; see release.ts' : false },
  () => {
    const daemonRoot = join(home, '.gitwarren', 'daemon')
    const layout = describeLayout('0.1.14', {
      script: join(daemonRoot, '0.1.14', 'lib', 'gitwarren.cjs'),
      mcpServer: null
    })

    // A tarball with no `gitwarren-daemon/bin/gitwarren` in it: the shape a
    // truncated download or the wrong asset has.
    const stage = mkdtempSync(join(tmpdir(), 'gitwarren-bad-'))
    mkdirSync(join(stage, 'gitwarren-daemon'), { recursive: true })
    const tarball = join(stage, 'bad.tar.gz')
    execFileSync('tar', ['czf', tarball, '-C', stage, 'gitwarren-daemon'])

    assert.throws(() => applyUpdate(layout, '0.1.15', tarball, 'linux-x64'), /did not contain/)
    assert.equal(existsSync(join(daemonRoot, '0.1.15')), false)
  }
)
