/**
 * Choosing a tarball, and getting it onto this disk.
 *
 * The `uname` mapping is the part worth pinning down: it is a table, tables get
 * edited, and the arm spellings differ between the two operating systems that
 * are supported - `aarch64` on Linux and `arm64` on macOS, for the same chip.
 * Getting one of those wrong produces a tarball that unpacks perfectly and
 * cannot execute, which is a confusing enough failure to be worth four
 * assertions.
 *
 * The download is exercised over a real socket rather than a stubbed `fetch`.
 * What is being tested is the streaming, the rename and the guard against a
 * body that is not a tarball, and none of those is really tested by a promise
 * that resolves with a string.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { AddressInfo } from 'node:net'

import {
  DAEMON_TARGETS,
  resolveTarball,
  tarballName,
  tarballUrl,
  targetFromUname,
  TARBALL_DIR_ENV_VAR
} from '../release.js'
import { AppError } from '../../../shared/errors.js'

const scratch = mkdtempSync(join(tmpdir(), 'gitwarren-release-'))
const TARBALL = gzipSync(Buffer.from('not really a tar, but it is really gzip'))

test('every uname a supported host can answer maps to a tarball that exists', () => {
  assert.equal(targetFromUname('Linux x86_64'), 'linux-x64')
  // The one that is spelled differently on each side, and the reason this is a
  // function rather than a template string at the call site.
  assert.equal(targetFromUname('Linux aarch64'), 'linux-arm64')
  assert.equal(targetFromUname('Darwin arm64'), 'darwin-arm64')
  assert.equal(targetFromUname('Darwin x86_64'), 'darwin-x64')

  // Trailing newline is what `uname` actually sends back over ssh.
  assert.equal(targetFromUname('Linux x86_64\n'), 'linux-x64')

  for (const target of [
    targetFromUname('Linux x86_64'),
    targetFromUname('Darwin arm64')
  ] as const) {
    assert.ok(DAEMON_TARGETS.includes(target))
  }
})

test('a machine with no tarball is told so by name, not left to fail at exec', () => {
  // 32-bit arm and Windows are both real answers from real hosts, and both are
  // better refused here than three steps later inside `tar`.
  assert.throws(() => targetFromUname('Linux armv7l'), /no GitWarren daemon/i)
  assert.throws(() => targetFromUname('MINGW64_NT-10.0 x86_64'), /Linux and macOS/i)
  assert.throws(() => targetFromUname(''), /that machine/i)
})

test('the asset name is the one the release workflow writes', () => {
  // `scripts/build-daemon-tarball.mjs` composes the same string. If these two
  // ever disagree the installer 404s on every host, so the shape is asserted
  // rather than left to a comment in each file pointing at the other.
  assert.equal(
    tarballName('0.1.7-beta.1', 'linux-x64'),
    'gitwarren-daemon-0.1.7-beta.1-linux-x64.tar.gz'
  )
  // The tag has a `v`; the file name does not.
  assert.equal(
    tarballUrl('0.1.7-beta.1', 'linux-arm64'),
    'https://github.com/klarluft/gitwarren-app/releases/download/v0.1.7-beta.1/' +
      'gitwarren-daemon-0.1.7-beta.1-linux-arm64.tar.gz'
  )
})

test('a staged local file is used, and nothing is downloaded', async () => {
  const local = mkdtempSync(join(scratch, 'local-'))
  const cache = mkdtempSync(join(scratch, 'cache-'))
  const name = tarballName('9.9.9', 'linux-x64')
  writeFileSync(join(local, name), TARBALL)

  const path = await resolveTarball('9.9.9', 'linux-x64', {
    localDirectory: local,
    cacheDirectory: cache,
    fetchImpl: () => assert.fail('a staged file must not be downloaded again')
  })

  assert.equal(path, join(local, name))
  // And it is used in place rather than copied into the cache: a directory
  // someone staged by hand is theirs, and duplicating 45 MB to reach it is a
  // cost with nothing on the other side.
  assert.deepEqual(readdirSync(cache), [])
})

test('a staged directory that lacks this version refuses rather than downloading', async () => {
  const local = mkdtempSync(join(scratch, 'empty-'))

  // The alternative - quietly falling through to the network - would install a
  // *different* build than the one someone deliberately put there, on a machine
  // where the two can differ. That is the surprise worth an error.
  await assert.rejects(
    resolveTarball('9.9.9', 'linux-x64', {
      localDirectory: local,
      cacheDirectory: mkdtempSync(join(scratch, 'cache-')),
      fetchImpl: () => assert.fail('a named directory must not fall through to the network')
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'NOT_FOUND')
      assert.match(error.message, new RegExp(TARBALL_DIR_ENV_VAR))
      return true
    }
  )
})

test('a download is streamed to the cache, and the second call does not repeat it', async () => {
  let served = 0
  const server = createServer((request, response) => {
    served += 1
    assert.equal(
      request.url,
      `/v9.9.9/${tarballName('9.9.9', 'linux-x64')}`,
      'the URL is composed from the version and the target, and nothing else'
    )
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(TARBALL)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => server.close())

  const cache = mkdtempSync(join(scratch, 'cache-'))
  const first = await resolveTarball('9.9.9', 'linux-x64', {
    cacheDirectory: cache,
    localDirectory: undefined,
    baseUrl: base
  })

  assert.deepEqual(readFileSync(first), TARBALL)
  // Nothing half-written left beside it: the download lands on a `.partial` and
  // is published by a rename, which is the only operation that can promise a
  // reader sees all of it or none of it.
  assert.deepEqual(readdirSync(cache), [tarballName('9.9.9', 'linux-x64')])

  const second = await resolveTarball('9.9.9', 'linux-x64', {
    cacheDirectory: cache,
    localDirectory: undefined,
    baseUrl: base
  })
  assert.equal(second, first)
  assert.equal(served, 1, 'a cached tarball is the whole point of caching it')
})

test('a draft release 404s, and the message says what to do about it', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404).end('Not Found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => server.close())

  await assert.rejects(
    resolveTarball('9.9.9', 'linux-x64', {
      cacheDirectory: mkdtempSync(join(scratch, 'cache-')),
      localDirectory: undefined,
      baseUrl: base
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'NOT_FOUND')
      // This is the failure anybody trying M4.2 today actually hits, because
      // the only release with daemon tarballs on it is still a draft.
      assert.match(error.message, /may not be published yet/i)
      assert.match(error.message, new RegExp(TARBALL_DIR_ENV_VAR))
      return true
    }
  )
})

test('a login page served with a 200 is not cached as a tarball', async () => {
  const server = createServer((_request, response) => {
    // The failure worth guarding against: a proxy or an SSO wall that answers
    // every request with HTML and a success status. `fetch` is perfectly happy
    // and the file lands on disk under the tarball's name, where it would fail
    // on every host it was streamed to for as long as the cache kept it.
    response.writeHead(200, { 'content-type': 'text/html' }).end('<html>Sign in</html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => server.close())

  const cache = mkdtempSync(join(scratch, 'cache-'))
  await assert.rejects(
    resolveTarball('9.9.9', 'linux-x64', {
      cacheDirectory: cache,
      localDirectory: undefined,
      baseUrl: base
    }),
    /not return a GitWarren daemon tarball/i
  )

  assert.deepEqual(readdirSync(cache), [], 'and nothing is left behind to be believed next time')
})
