/**
 * The order of the four commands, and what each answer is allowed to mean.
 *
 * `runOverSsh` is swapped for a recorder here, which is worth being honest
 * about: this tests the *sequence* and the decisions, not that any of it works
 * against a machine. The second half of that is `docs/across-hosts.md` under
 * M4.2, where `~/.gitwarren` on `pc-wsl` was wiped and rebuilt from scratch by
 * this code - which is the only way to find out that a remote `sh` disagrees
 * with the one on this laptop.
 *
 * What a recorder does catch, and catches cheaply, is the class of mistake that
 * would otherwise be found on somebody else's server: touching the host before
 * the download has succeeded, believing the launcher without reading it back,
 * and shipping a script that reaches for a `tar` flag busybox has never had.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { installOnHost } from '../install.js'
import { tarballName } from '../release.js'
import type { HostRunResult } from '../carrier.js'
import type { HostRoute } from '../pool.js'
import { AppError } from '../../../shared/errors.js'

const ROUTE: HostRoute = { id: 1, kind: 'ssh', target: 'xfor@pc-wsl' }
const VERSION = '9.9.9'

const scratch = mkdtempSync(join(tmpdir(), 'gitwarren-install-'))
const staged = join(scratch, tarballName(VERSION, 'linux-x64'))
writeFileSync(staged, gzipSync(Buffer.from('a tarball, for the purposes of this test')))

interface Recorded {
  command: string
  hadStdin: boolean
}

/**
 * A host that answers whatever the test says it answers.
 *
 * Keyed by a substring of the command rather than by call index, so a test
 * reads as "when it asks about the version, say this" and does not have to be
 * renumbered when a step is added between two others.
 */
function fakeHost(answers: Array<[match: string, result: Partial<HostRunResult>]>) {
  const calls: Recorded[] = []

  const run = ({
    command,
    stdin
  }: {
    command: string
    stdin?: unknown
  }): Promise<HostRunResult> => {
    calls.push({ command, hadStdin: stdin !== undefined })
    // Consume the stream so a `createReadStream` in the real code does not sit
    // open on a file descriptor for the rest of the run.
    if (stdin && typeof (stdin as { resume?: () => void }).resume === 'function') {
      ;(stdin as { resume: () => void }).resume()
    }
    for (const [match, result] of answers) {
      if (command.includes(match)) {
        return Promise.resolve({ code: 0, stdout: '', stderr: '', ...result })
      }
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }

  return { run: run as never, calls }
}

/** The four steps, in the order `installOnHost` runs them. */
function shapeOf(calls: Recorded[]): string[] {
  return calls.map((call) => {
    if (call.command.includes('uname')) return 'uname'
    if (call.command.includes('--version')) return 'version'
    if (call.command.includes('tar xzf')) return 'unpack'
    if (call.command.includes('service install')) return 'launchers'
    return `unknown: ${call.command.slice(0, 40)}`
  })
}

test('a host with nothing on it gets asked, then sent, then made to prove itself', async () => {
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    // 127 is what `sh` returns for a launcher that is not there, and is the
    // ordinary answer on a machine that has never had GitWarren.
    ['--version', { code: 127 }]
  ])

  // The version read-back at the end has to succeed, so the second `--version`
  // answers differently from the first. Order matters in this list.
  host.calls.length = 0
  let seenVersion = false
  const run = (async (options: { command: string; stdin?: unknown }) => {
    const result = await (host.run as unknown as (o: unknown) => Promise<HostRunResult>)(options)
    if (options.command.includes('--version')) {
      if (seenVersion) return { code: 0, stdout: `${VERSION}\n`, stderr: '' }
      seenVersion = true
    }
    return result
  }) as never

  const report = await installOnHost(ROUTE, {
    version: VERSION,
    run,
    resolve: () => Promise.resolve(staged)
  })

  assert.deepEqual(shapeOf(host.calls), ['uname', 'version', 'unpack', 'launchers', 'version'])
  assert.equal(report.action, 'installed')
  assert.equal(report.previousVersion, null)
  assert.equal(report.target, 'linux-x64')
  assert.ok(report.bytes > 0)

  // The bytes travel on stdin of exactly one command, and it is the one that
  // unpacks them.
  assert.deepEqual(
    host.calls.filter((call) => call.hadStdin).map((call) => shapeOf([call])[0]),
    ['unpack']
  )
})

test('a host already on this version is not sent 45 MB again', async () => {
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    ['--version', { stdout: `${VERSION}\n` }]
  ])

  const report = await installOnHost(ROUTE, {
    version: VERSION,
    run: host.run,
    resolve: () => assert.fail('nothing should be fetched for a host that is already current')
  })

  assert.equal(report.action, 'already-current')
  assert.equal(report.bytes, 0)
  assert.deepEqual(shapeOf(host.calls), ['uname', 'version'])
})

test('force reinstalls a host that is already current', async () => {
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    ['--version', { stdout: `${VERSION}\n` }]
  ])

  const report = await installOnHost(ROUTE, {
    version: VERSION,
    force: true,
    run: host.run,
    resolve: () => Promise.resolve(staged)
  })

  // `upgraded` rather than `installed`, because something was there - even
  // though it was the same thing.
  assert.equal(report.action, 'upgraded')
  assert.equal(report.previousVersion, VERSION)
  assert.deepEqual(shapeOf(host.calls), ['uname', 'version', 'unpack', 'launchers', 'version'])
})

test('an older version is an upgrade, and says what it came from', async () => {
  let seen = 0
  const run = (({ command }: { command: string; stdin?: unknown }) => {
    if (command.includes('uname')) {
      return Promise.resolve({ code: 0, stdout: 'Darwin arm64\n', stderr: '' })
    }
    if (command.includes('--version')) {
      seen += 1
      return Promise.resolve({
        code: 0,
        stdout: seen === 1 ? '0.1.6\n' : `${VERSION}\n`,
        stderr: ''
      })
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }) as never

  const report = await installOnHost(ROUTE, {
    version: VERSION,
    run,
    resolve: (_version, target) => {
      // The target comes from the host's own `uname`, not from this machine's
      // platform - which is the whole reason a Mac can install onto Linux.
      assert.equal(target, 'darwin-arm64')
      return Promise.resolve(staged)
    }
  })

  assert.equal(report.action, 'upgraded')
  assert.equal(report.previousVersion, '0.1.6')
  assert.equal(report.target, 'darwin-arm64')
})

test('nothing is touched on the host when the download fails', async () => {
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    ['--version', { code: 127 }]
  ])

  await assert.rejects(
    installOnHost(ROUTE, {
      version: VERSION,
      run: host.run,
      resolve: () => Promise.reject(new AppError('NOT_FOUND', 'no such release'))
    }),
    /no such release/
  )

  // A download that fails must leave the machine exactly as it was, rather than
  // part-way through an upgrade with the old version already moved aside.
  assert.deepEqual(shapeOf(host.calls), ['uname', 'version'])
})

test('a tarball that unpacks but cannot run is reported as the wrong architecture', async () => {
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    ['--version', { code: 127 }],
    // What a linux-arm64 `node` does on an x86-64 box: `tar` was perfectly
    // happy, and the first `exec` is where it goes wrong.
    ['service install', { code: 126, stderr: 'cannot execute binary file: Exec format error' }]
  ])

  await assert.rejects(
    installOnHost(ROUTE, { version: VERSION, run: host.run, resolve: () => Promise.resolve(staged) }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.match(error.message, /Exec format error/)
      assert.match(error.message, /wrong one for that machine/)
      return true
    }
  )
})

test('a launcher that still points somewhere else is not called a success', async () => {
  // The read-back exists for this: another install on the same machine - a
  // Homebrew `gitwarren`, a second GUI - maintains the same stable path, and
  // reporting a version that is not what the carrier will actually spawn is the
  // kind of wrong that is only discovered much later.
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    ['--version', { stdout: '0.1.6\n' }]
  ])

  await assert.rejects(
    installOnHost(ROUTE, { version: VERSION, run: host.run, resolve: () => Promise.resolve(staged) }),
    /still reports 0\.1\.6 after installing 9\.9\.9/
  )
})

test('the remote script uses nothing a minimal sh and tar lack', async () => {
  const host = fakeHost([
    ['uname', { stdout: 'Linux x86_64\n' }],
    ['--version', { code: 127 }]
  ])
  let seen = 0
  const run = (async (options: { command: string; stdin?: unknown }) => {
    const result = await (host.run as unknown as (o: unknown) => Promise<HostRunResult>)(options)
    if (options.command.includes('--version') && seen++ > 0) {
      return { code: 0, stdout: `${VERSION}\n`, stderr: '' }
    }
    return result
  }) as never

  await installOnHost(ROUTE, { version: VERSION, run, resolve: () => Promise.resolve(staged) })
  const unpack = host.calls.find((call) => call.command.includes('tar xzf'))?.command ?? ''

  // busybox `tar` has neither of these, and a WSL image or a container that
  // uses it would fail on a flag rather than on anything real. The archive's
  // own directory is moved instead.
  assert.doesNotMatch(unpack, /--strip-components/)
  assert.doesNotMatch(unpack, /--transform/)
  // No bashisms: `[[`, arrays, `local`. `sh` is what a remote command gets.
  assert.doesNotMatch(unpack, /\[\[/)
  // A `tar` that fails must not be followed by a `mv` that installs an empty
  // directory and calls it done.
  assert.match(unpack, /^set -e$/m)
  // And the version is quoted, because it reaches the remote shell as text.
  assert.match(unpack, /"9\.9\.9"/)
})
