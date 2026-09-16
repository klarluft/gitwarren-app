/**
 * `gitwarren doctor`, which is one command about a failure that has no symptom
 * on this machine at all: a launcher pointing at a file that is gone. The
 * agent that tries to start it reports "MCP server failed to connect", in
 * another product, with nothing naming the cause.
 *
 * So the assertions are about the report being *usable*: the broken line is
 * marked, the exit code is non-zero so a script can be the thing that notices,
 * and a file GitWarren did not write is reported rather than repaired.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { getMcpLauncherPath } from '../../core/mcp-launcher.js'
import { runDoctor } from '../doctor.js'
import { describeLayout, type InstallLayout } from '../layout.js'

let home: string
const saved = new Map<string, string | undefined>()
const realLog = console.log
const realError = console.error

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitwarren-doctor-'))
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GITWARREN_DATA_DIR']) {
    saved.set(name, process.env[name])
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.GITWARREN_DATA_DIR = join(home, 'data')
})

afterEach(() => {
  console.log = realLog
  console.error = realError
  process.exitCode = undefined
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  rmSync(home, { recursive: true, force: true })
})

/**
 * A managed install with every file it names present, so that the only fault
 * in a report is the one the test put there.
 */
function healthy(): InstallLayout {
  const prefix = join(home, '.gitwarren', 'daemon', '0.1.14')
  mkdirSync(join(prefix, 'lib'), { recursive: true })
  const server = join(prefix, 'lib', 'server.cjs')
  writeFileSync(join(prefix, 'lib', 'gitwarren.cjs'), '// a bundle\n')
  writeFileSync(server, '// a server\n')

  return describeLayout('0.1.14', { script: join(prefix, 'lib', 'gitwarren.cjs'), mcpServer: server })
}

function capture(argv: readonly string[]): { out: string; code: number | undefined } {
  let out = ''
  console.log = (line: string) => {
    out += `${line}\n`
  }
  console.error = (line: string) => {
    out += `${line}\n`
  }
  runDoctor(argv, healthy())
  return { out, code: process.exitCode as number | undefined }
}

/** A launcher naming a file that used to be there. `brew uninstall`, in effect. */
function danglingMcpLauncher(): string {
  const gone = join(home, 'Cellar', 'gitwarren-cli', '0.1.14', 'libexec', 'lib', 'server.cjs')
  mkdirSync(join(home, '.gitwarren', 'bin'), { recursive: true })
  writeFileSync(
    getMcpLauncherPath(),
    '#!/bin/sh\n' +
      '# GitWarren MCP server. Written by the gitwarren command line, so a config or a\n' +
      '# Generated file - rerun `gitwarren service install` to refresh it, do not edit this.\n' +
      `exec "/usr/bin/node" "${gone}" "$@"\n`
  )
  return gone
}

test('a launcher pointing at something that is gone is marked, and fails the run', () => {
  const gone = danglingMcpLauncher()

  const { out, code } = capture([])

  assert.match(out, /^! MCP launcher/m)
  assert.ok(out.includes(gone.replace(home, '~')), 'the report should name what it points at')
  assert.match(out, /not there any more/)
  assert.equal(code, 1)
})

test('without --fix it says what --fix would do, and changes nothing', () => {
  danglingMcpLauncher()
  const before = readLauncher()

  const { out } = capture([])

  assert.match(out, /gitwarren doctor --fix` would:/)
  assert.equal(readLauncher(), before)
})

test('a report with nothing wrong says so and exits zero', () => {
  // No launchers at all is not a fault: a machine that has only ever had the
  // app, or one where nothing has been run yet, looks exactly like this. The
  // missing MCP launcher is a warning, and a warning is not a failure.
  const { out, code } = capture([])

  assert.ok(!out.includes('!'), out)
  assert.match(out, /Nothing is broken\./)
  assert.equal(code, undefined)
})

test('--fix repoints a launcher at the install that is running, or says why it cannot', () => {
  // The repair writes the launchers for *this* process, not for the layout the
  // report was built from: a launcher has to carry the running install's own
  // environment - see `cli/install.ts` - and only the running install knows
  // it. Under tsx there is no file a login shell could run again, so what this
  // asserts is the refusal, in the same words `service install` gives.
  danglingMcpLauncher()
  const before = readLauncher()

  const { out, code } = capture(['--fix'])

  assert.match(out, /source checkout/)
  assert.equal(code, 1)
  assert.equal(readLauncher(), before, 'a refusal must not half-write the file')
})

test('an unknown flag is the usage, not a report', () => {
  const { out } = capture(['--repair'])

  assert.match(out, /gitwarren doctor \[--fix\]/)
  assert.ok(!out.includes('Login item'))
})

function readLauncher(): string {
  return readFileSync(getMcpLauncherPath(), 'utf8')
}
