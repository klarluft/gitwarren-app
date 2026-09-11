/**
 * The argument vector, the encoding, and the stream `wsl.exe` writes on.
 *
 * Small assertions about a small file, and worth having for the same reason
 * `ssh.test.ts` is: every one of them is load-bearing in a way that is
 * invisible at a glance, and three of them are things that looked like they
 * worked until they were measured.
 *
 * Reaching a real distribution is `docs/across-hosts.md`'s job, under M5's
 * verify sentence, and was done against Ubuntu on this PC before this code was
 * written.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeWslExit, wslArgs, wslEnvironment, wslRunArgs, wslSaid } from '../wsl.js'
import { REMOTE_LAUNCHER } from '../carrier.js'
import { DAEMON_READY_PREFIX } from '../../../shared/rpc.js'

test('the command goes through -e, not through the login shell', () => {
  const args = wslArgs('Ubuntu')

  // `-e` is what stops the distribution's login shell expanding the words
  // before `exec` sees them. With `--` instead, a script's `$$` is the *outer*
  // shell's pid - measured on this machine as 1269 where the inner shell said
  // 1274 - which is a wrong answer that still looks like a right one.
  assert.deepEqual(args.slice(0, 4), ['-d', 'Ubuntu', '-e', 'sh'])
  assert.equal(args[4], '-c')
  // The distro comes immediately after `-d`, so nothing a person picked can be
  // read as an option to `wsl.exe`.
  assert.equal(args[1], 'Ubuntu')
})

test('the command starts the launcher, not a versioned path', () => {
  const script = wslArgs('Ubuntu')[5]

  assert.ok(script?.includes(`${REMOTE_LAUNCHER} serve --stdio`))
  // `~` and not an absolute path: only a shell inside the distribution knows
  // where home is. Here it is the inner `sh` that expands it, which is the
  // whole reason `sh -c` is named rather than relying on `--`.
  assert.match(REMOTE_LAUNCHER, /^~\//)
  // `exec`, so no shell sits between `wsl.exe` and the daemon holding the pipe.
  // A process inside the distribution is what stops WSL idling the virtual
  // machine down, and one of them is enough.
  assert.match(script ?? '', /^exec /)
})

test('a script crosses as one argument, the way it does over ssh', () => {
  const script = 'set -e\nroot=$HOME/.gitwarren\necho "$root"'
  const args = wslRunArgs('Ubuntu', script)

  // One argument, verbatim, newlines and all. This is what makes
  // `core/hosts/install.ts` work over either carrier without knowing which.
  assert.equal(args.at(-1), script)
  assert.deepEqual(args.slice(0, 5), ['-d', 'Ubuntu', '-e', 'sh', '-c'])
})

test('the child is told to speak UTF-8', () => {
  // Without this, `wsl.exe` writes its own messages as UTF-16LE while the
  // guest writes UTF-8, so one stream carries two encodings and
  // `setEncoding('utf8')` turns half of it into mojibake.
  assert.equal(wslEnvironment({ PATH: '/usr/bin' }).WSL_UTF8, '1')
  // Layered rather than replacing: `wsl.exe` needs the Windows user's
  // environment to find the distribution at all.
  assert.equal(wslEnvironment({ PATH: '/usr/bin' }).PATH, '/usr/bin')
})

test('what wsl.exe said is told apart from what the daemon said', () => {
  // The property with no `ssh` analogue: `wsl.exe` puts its errors on *stdout*,
  // which is the stream the protocol owns. A frame is a JSON object, so a line
  // that does not start with `{` was not one.
  const mixed = '{"id":1,"result":[]}\nThere is no distribution with the supplied name.\n'

  assert.equal(wslSaid(mixed), 'There is no distribution with the supplied name.')
  assert.equal(wslSaid('{"id":1,"result":[]}\n'), '')
  assert.equal(wslSaid(''), '')
})

test('a distribution that is not installed says what wsl.exe said', () => {
  // -1 as Windows reports it. Both spellings are accepted because which one
  // arrives is a detail of the platform rather than a promise.
  for (const code of [-1, 4294967295]) {
    const message = describeWslExit(
      'no-such-distro',
      code,
      null,
      'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n',
      ''
    )
    assert.match(message, /could not start no-such-distro/)
    assert.match(message, /no distribution with the supplied name/)
  }
})

test('a distribution without GitWarren is told so by name', () => {
  // Exit 127 from `sh`, exactly as over `ssh`, which is why it is the same
  // sentence: this is the single most likely outcome of adding a host until it
  // has been installed onto.
  const message = describeWslExit('Ubuntu', 127, null, '', 'sh: 1: /home/xfor/x: not found\n')

  assert.match(message, /GitWarren is not installed on Ubuntu/)
  assert.match(message, /Install the daemon/)
})

test('a distribution shut down under us is the silent case, and says so', () => {
  // `wsl --terminate Ubuntu` ends the pipe and exits 1 without one word on
  // either stream - measured. It is the only failure here whose message has to
  // be invented rather than quoted, so it is worded as a possibility.
  const message = describeWslExit('Ubuntu', 1, null, '', '')

  assert.match(message, /without saying why/)
  assert.match(message, /terminate/)
})

test('an exit 1 that did say something is not blamed on a shutdown', () => {
  // The same status, and the evidence is what tells them apart: a daemon that
  // failed on its own account said so on stderr.
  const message = describeWslExit('Ubuntu', 1, null, '', 'gitwarren: database is locked\n')

  assert.doesNotMatch(message, /without saying why/)
  assert.match(message, /database is locked/)
})

test('a healthy start is never offered as the reason a connection died', () => {
  // M4.5's rule, inherited whole through `diagnosticTail`: proof that the
  // daemon started is the one thing that cannot be why it stopped.
  const message = describeWslExit(
    'Ubuntu',
    null,
    'SIGKILL',
    '',
    `${DAEMON_READY_PREFIX} (instance abc, protocol v1)\n`
  )

  assert.match(message, /terminated \(SIGKILL\)/)
  assert.doesNotMatch(message, /ready/)
})
