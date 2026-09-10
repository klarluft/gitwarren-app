/**
 * The bytes that land in a user's home directory.
 *
 * Every one of these files is read by an operating system, not by us, and a
 * mistake in one is invisible until the machine is rebooted: launchd rejects a
 * malformed plist in silence, and systemd's complaint goes to a journal nobody
 * is watching at login. Two of the three cannot be exercised on the machine
 * this test runs on either - which is exactly why `units.ts` is strings and no
 * side effects, and why the assertions below are on the literal text.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LAUNCHD_LABEL,
  SERVE_ARGS,
  launchAgent,
  systemdUnit,
  windowsTaskCommand,
  xmlEscape
} from '../units.js'

const LAUNCHER = '/Users/someone/.gitwarren/bin/gitwarren'
const LOG = '/Users/someone/Library/Logs/GitWarren/daemon.log'

test('the LaunchAgent runs the launcher with serve --listen', () => {
  const plist = launchAgent(LAUNCHER, LOG)
  for (const value of [LAUNCHER, ...SERVE_ARGS]) {
    assert.ok(plist.includes(`<string>${value}</string>`), `missing ${value}`)
  }
  assert.ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`))
})

test('the LaunchAgent starts at load and is not kept alive', () => {
  const plist = launchAgent(LAUNCHER, LOG)
  assert.ok(plist.includes('<key>RunAtLoad</key>'))
  // See the header of units.ts: `gitwarren serve --listen` has a refusal it is
  // meant to exit on, and a restart policy turns that into a loop.
  assert.ok(!plist.includes('KeepAlive'))
})

test('a home directory with an ampersand does not break the plist', () => {
  // launchd rejects the whole file, and the login item then simply never runs -
  // with nothing anywhere saying why.
  const plist = launchAgent('/Users/a&b/.gitwarren/bin/gitwarren', LOG)
  assert.ok(plist.includes('/Users/a&amp;b/.gitwarren/bin/gitwarren'))
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(plist))
})

test('xmlEscape covers the five that matter', () => {
  assert.equal(xmlEscape('<a & b "c">'), '&lt;a &amp; b &quot;c&quot;&gt;')
})

test('the systemd unit is a user unit that starts with the session', () => {
  const unit = systemdUnit(LAUNCHER)
  assert.ok(unit.includes('WantedBy=default.target'))
  assert.ok(unit.includes('Type=simple'))
  assert.ok(unit.includes('Restart=no'))
})

test('the systemd ExecStart quotes the launcher', () => {
  // systemd splits ExecStart on whitespace, and a home directory can contain
  // some. Unquoted, the daemon would be asked to run a program that is the
  // first word of somebody's name.
  const unit = systemdUnit('/home/some one/.gitwarren/bin/gitwarren')
  assert.ok(unit.includes('ExecStart="/home/some one/.gitwarren/bin/gitwarren" "serve" "--listen"'))
})

test('the Windows task command quotes the launcher and nothing else', () => {
  const command = windowsTaskCommand('C:\\Users\\Some Name\\.gitwarren\\bin\\gitwarren.cmd')
  assert.equal(command, '"C:\\Users\\Some Name\\.gitwarren\\bin\\gitwarren.cmd" serve --listen')
  // Escaped quotes would be for a shell, and `service.ts` spawns schtasks
  // through execFileSync without one - they would end up inside the task.
  assert.ok(!command.includes('\\"'))
})
