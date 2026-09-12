/**
 * The words a person reads first, and the side effect `serve` grew.
 *
 * The usage block is the only documentation most people will read, so the
 * assertions here are about what it says rather than that it exists: every
 * subcommand is in it, including `uninstall`, which the first version left out
 * of every place a newcomer looked, and the three things a person wants are
 * named as headings so the list reads as choices rather than as an inventory.
 *
 * `ensureLaunchers` is tested for the one property `serve` depends on: under
 * tsx there is no file a login shell could run again, and that has to come
 * back as a sentence, not a throw - a `serve` from a checkout still has a page
 * to serve.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ensureLaunchers } from '../launchers.js'
import { runCli } from '../router.js'

const realLog = console.log
const realError = console.error

afterEach(() => {
  console.log = realLog
  console.error = realError
})

function capture(argv: readonly string[]): { ok: boolean; out: string; err: string } {
  let out = ''
  let err = ''
  console.log = (line: string) => {
    out += `${line}\n`
  }
  console.error = (line: string) => {
    err += `${line}\n`
  }
  const ok = runCli(argv)
  return { ok, out, err }
}

test('--help names every subcommand, uninstall included, grouped by what a person wants', () => {
  const { ok, out } = capture(['--help'])

  assert.equal(ok, true)
  for (const command of [
    'gitwarren serve',
    'gitwarren serve --stdio',
    'gitwarren open',
    'gitwarren service install',
    'gitwarren service uninstall',
    'gitwarren service status',
    'gitwarren agent-setup',
    'gitwarren --version'
  ]) {
    assert.ok(out.includes(command), `usage should mention \`${command}\``)
  }
  for (const heading of ['Run it now', 'Keep it running', 'Let a coding agent in']) {
    assert.ok(out.includes(heading), `usage should have the heading "${heading}"`)
  }
})

test('an unknown command is the usage on stderr and a false, not a throw', () => {
  const { ok, out, err } = capture(['frobnicate'])

  assert.equal(ok, false)
  assert.equal(out, '')
  assert.ok(err.includes('gitwarren serve'))
})

test('serve --help is its own usage, and does not start a server', () => {
  const { ok, out } = capture(['serve', '--help'])

  assert.equal(ok, true)
  assert.ok(out.includes('--open'))
  assert.ok(out.includes('--stdio'))
  assert.ok(out.includes('gitwarren-mcp'))
})

test('a checkout cannot have launchers written, and says so instead of throwing', () => {
  // This test runs under tsx, so `argv[1]` is a .ts file: exactly the case
  // `serve` must survive.
  const result = ensureLaunchers()

  assert.deepEqual(result.created, [])
  assert.match(result.refused ?? '', /source checkout/)
})
