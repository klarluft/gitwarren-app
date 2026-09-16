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
  // Every command captured here is one that answers without awaiting
  // anything. `update` and `uninstall` answer with a promise, and a test that
  // silently treated one as truthy would assert nothing at all.
  const ok = runCli(argv)
  if (typeof ok !== 'boolean') throw new Error(`\`${argv.join(' ')}\` answered with a promise`)
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
    'gitwarren mcp',
    'gitwarren update',
    'gitwarren doctor',
    'gitwarren uninstall',
    'gitwarren --version'
  ]) {
    assert.ok(out.includes(command), `usage should mention \`${command}\``)
  }
  for (const heading of [
    'Run it now',
    'Keep it running',
    'Let a coding agent in',
    'Keep it current, or remove it'
  ]) {
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

test('mcp --help is its own usage, and does not start a server', () => {
  const { ok, out } = capture(['mcp', '--help'])

  assert.equal(ok, true)
  assert.ok(out.includes('npx gitwarren mcp'))
  assert.ok(out.includes('gitwarren-mcp'))
  assert.ok(out.includes('--serve'))
})

test('mcp takes nothing but --serve: anything else is the usage on stderr, not a server', () => {
  // A wrong invocation must never reach the server - it would take over stdout
  // and this test would be talking MCP to a test runner. `--serve` beside an
  // unknown flag is still wrong: the unknown flag is the problem.
  for (const argv of [
    ['mcp', '--listen'],
    ['mcp', '--serve', '--listen']
  ]) {
    const { ok, out, err } = capture(argv)

    assert.equal(ok, false, `${argv.join(' ')} should be refused`)
    assert.equal(out, '')
    assert.ok(err.includes('gitwarren mcp'))
  }
})

test('update and uninstall refuse a bad flag before they await anything', () => {
  // Both answer with a promise, and both parse argv first: a typo has to be
  // the usage and an exit code, not a download or a question. `capture`
  // throws on a promise, which is what makes this an assertion at all.
  for (const argv of [
    ['update', '--latest'],
    ['update', '--version'],
    ['uninstall', '--everything']
  ]) {
    const { ok, out, err } = capture(argv)

    assert.equal(ok, false, `${argv.join(' ')} should be refused`)
    assert.equal(out, '')
    assert.ok(err.includes(`gitwarren ${argv[0]}`))
  }
})

test('each new command has its own usage, and --help does not do the thing', () => {
  assert.match(capture(['update', '--help']).out, /--check/)
  assert.match(capture(['doctor', '--help']).out, /--fix/)
  assert.match(capture(['uninstall', '--help']).out, /--data/)

  // The one distinction the two uninstalls have to keep clear: which command
  // removes the login item and which removes GitWarren.
  assert.match(capture(['uninstall', '--help']).out, /service uninstall/)
})

test('a checkout cannot have launchers written, and says so instead of throwing', () => {
  // This test runs under tsx, so `argv[1]` is a .ts file: exactly the case
  // `serve` must survive.
  const result = ensureLaunchers()

  assert.deepEqual(result.created, [])
  assert.match(result.refused ?? '', /source checkout/)
})
