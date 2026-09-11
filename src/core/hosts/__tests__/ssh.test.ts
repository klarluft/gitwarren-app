/**
 * The argument vector, and the rule about what never leaves the machine.
 *
 * Small assertions about a small file, and worth having for two reasons. The
 * options are load-bearing in a way that is invisible at a glance - drop
 * `BatchMode` and a missing key turns a spinner into a hang rather than an
 * error - and the local-only rule is a security-shaped property that would
 * otherwise be enforced only by a comment.
 *
 * Reaching a real host is `docs/across-hosts.md`'s job, under M4's verify
 * sentence, and was done against `pc-wsl` before this code was written.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { connectOverSsh, describeExit, sshArgs, REMOTE_LAUNCHER, SSH_OPTIONS } from '../ssh.js'
import { isLocalOnly } from '../carrier.js'
import { rpcMethodNames } from '../../rpc/dispatcher.js'
import { DAEMON_READY_PREFIX } from '../../../shared/rpc.js'

test('the command starts the launcher, not a versioned path', () => {
  const args = sshArgs('xfor@pc-wsl')

  assert.deepEqual(args.slice(-3), [REMOTE_LAUNCHER, 'serve', '--stdio'])
  // `~` and not an absolute path: only the remote shell knows where home is.
  assert.match(REMOTE_LAUNCHER, /^~\//)
  // The target comes immediately before the command, so nothing a person typed
  // can be read as an option to `ssh`.
  assert.equal(args[args.length - 4], 'xfor@pc-wsl')
})

test('a hang is turned into an error before anything else', () => {
  // Without this, `ssh` waits at a passphrase prompt on a stdin carrying JSON
  // and no human, and the GUI spins forever.
  assert.ok(SSH_OPTIONS.includes('BatchMode=yes'))
})

test('the connection is multiplexed and kept alive', () => {
  // The first is what makes a reconnect cheap; the second is what makes a dead
  // connection noticeable at all, rather than a socket nobody gives up on.
  assert.ok(SSH_OPTIONS.includes('ControlMaster=auto'))
  assert.ok(SSH_OPTIONS.some((option) => option.startsWith('ServerAliveInterval=')))
})

test('a host that cannot be resolved says what ssh said, not that a stream ended', async () => {
  // The bug this test exists for was found against a real machine and is
  // entirely about ordering: the protocol notices a dead connection when stdout
  // ends, which for a failing `ssh` is a moment *before* the exit that carries
  // the status and completes stderr. Reading the reason at the instant the
  // request failed produced "The connection to the host closed." for a hostname
  // that does not resolve - true, and no help to anybody.
  const connection = connectOverSsh({ target: 'gitwarren-no-such-host.invalid' })

  await assert.rejects(connection.request('repositories.list'))

  const reason = await connection.diagnostics()
  assert.match(reason, /ssh could not connect/i)
  assert.match(reason, /no-such-host/i)
  connection.close()
})

test('a healthy start is never offered as the reason a connection died', () => {
  // Found in M4.5 by killing the `ssh` under an open review: the daemon had
  // started perfectly and said so on stderr, and the banner came back stuck to
  // the end of the failure - "The connection to xfor@pc-wsl was terminated
  // (SIGKILL). [gitwarren-serve] ready (instance …, protocol v1, database: …)".
  // Both halves true; the second one the opposite of an explanation.
  const banner = `${DAEMON_READY_PREFIX} (instance 4e0b0adb, protocol v1, database: /home/xfor/db)`

  const killed = describeExit('xfor@pc-wsl', null, 'SIGKILL', banner)
  assert.equal(killed, 'The connection to xfor@pc-wsl was terminated (SIGKILL).')

  // Anything else on that stream might genuinely be why, so it is kept - even
  // when the banner is sitting above it.
  const withReason = describeExit(
    'xfor@pc-wsl',
    1,
    null,
    `${banner}\nsqlite: database is locked`
  )
  assert.match(withReason, /sqlite: database is locked/)
  assert.doesNotMatch(withReason, /ready \(instance/)
})

test('host management is answered here and never sent to a host', () => {
  // A prefix rather than a list, so `hosts.rename` tomorrow cannot quietly
  // become forwardable by being forgotten.
  for (const method of rpcMethodNames.filter((name) => name.startsWith('hosts.'))) {
    assert.equal(isLocalOnly(method), true, `${method} must not leave this machine`)
  }

  // And everything else must, or a remote host would be unusable.
  for (const method of rpcMethodNames.filter((name) => !name.startsWith('hosts.'))) {
    assert.equal(isLocalOnly(method), false, `${method} has to be answerable by a host`)
  }
})
