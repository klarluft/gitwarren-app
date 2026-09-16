/**
 * What `gitwarren uninstall` will and will not delete.
 *
 * The plan is built before anything is removed and is the same object that
 * then runs, so these tests hold the plan rather than the prompt - the
 * question a person answers `y` to is exactly this list.
 *
 * Two properties, and the second is the one that keeps somebody else's machine
 * working: reviews survive unless `--data` says otherwise, and a launcher that
 * names another GitWarren is left alone. A machine with the desktop app and
 * the command line on it shares `~/.gitwarren/bin`, and an uninstall that took
 * the app's launcher would remove agent access from an install the user never
 * touched.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { getCliLauncherPath, getMcpLauncherPath } from '../../core/mcp-launcher.js'
import { getDataDirectory } from '../../core/paths.js'
import { describeLayout, type InstallLayout } from '../layout.js'
import { writeLaunchers } from '../launchers.js'
import { buildPlan } from '../uninstall.js'

let home: string
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitwarren-uninstall-'))
  for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GITWARREN_DATA_DIR']) {
    saved.set(name, process.env[name])
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.GITWARREN_DATA_DIR = join(home, 'data')

  mkdirSync(join(home, 'data'), { recursive: true })
  writeFileSync(join(home, 'data', 'gitwarren.db'), 'reviews live here')
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
  rmSync(home, { recursive: true, force: true })
})

/** A managed install with its launchers written, the way install.sh leaves one. */
function managed(version: string): InstallLayout {
  const prefix = join(home, '.gitwarren', 'daemon', version)
  mkdirSync(join(prefix, 'lib'), { recursive: true })
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  const script = join(prefix, 'lib', 'gitwarren.cjs')
  const server = join(prefix, 'lib', 'server.cjs')
  writeFileSync(script, '// a bundle\n')
  writeFileSync(server, '// a server\n')
  writeFileSync(join(prefix, 'bin', 'gitwarren'), '#!/bin/sh\n')

  const layout = describeLayout(version, { script, mcpServer: server })
  writeLaunchers({ node: process.execPath, script, mcpServer: server, env: {} })
  return layout
}

function run(plan: ReturnType<typeof buildPlan>): string[] {
  return plan.steps.flatMap((step) => step.act())
}

const skipOnWindows =
  process.platform === 'win32'
    ? 'a Windows login item lives in a global store, not under a test HOME'
    : false

test(
  'a managed install is removed with its launchers, and the reviews are not',
  { skip: skipOnWindows },
  () => {
    const layout = managed('0.1.14')

    const plan = buildPlan(layout, false)
    run(plan)

    assert.equal(existsSync(layout.daemonRoot), false)
    assert.equal(existsSync(getCliLauncherPath()), false)
    assert.equal(existsSync(getMcpLauncherPath()), false)
    // `~/.gitwarren` went too, because this took the last thing out of it.
    assert.equal(existsSync(layout.home), false)

    assert.equal(existsSync(join(getDataDirectory(), 'gitwarren.db')), true)
    assert.ok(plan.notes.some((note) => /Reviews are kept/.test(note)))
  }
)

test('--data is the only way the reviews go', { skip: skipOnWindows }, () => {
  const layout = managed('0.1.14')

  const plan = buildPlan(layout, true)
  assert.ok(plan.steps.some((step) => /every review and comment/.test(step.title)))

  run(plan)

  assert.equal(existsSync(getDataDirectory()), false)
})

test(
  'the desktop app keeps its launcher, and is named rather than passed over',
  { skip: skipOnWindows },
  () => {
    const layout = managed('0.1.14')

    // The app's MCP launcher, written over the command line's the way a
    // machine with both on it ends up - last writer wins, and both work.
    const appServer = join(home, 'Applications', 'GitWarren', 'server.cjs')
    mkdirSync(join(home, 'Applications', 'GitWarren'), { recursive: true })
    writeFileSync(appServer, '// the app\n')
    writeFileSync(
      getMcpLauncherPath(),
      '#!/bin/sh\n' +
        '# GitWarren MCP server. Rewritten by GitWarren whenever the install moves,\n' +
        '# Generated file - edit GitWarren, not this.\n' +
        `ELECTRON_RUN_AS_NODE=1 exec "/usr/lib/gitwarren/electron" "${appServer}" "$@"\n`
    )

    const plan = buildPlan(layout, false)
    run(plan)

    assert.equal(existsSync(getCliLauncherPath()), false)
    assert.equal(existsSync(getMcpLauncherPath()), true, "the app's launcher must survive")
    assert.deepEqual(
      plan.keeping.map((report) => report.path),
      [getMcpLauncherPath()]
    )
    // And `~/.gitwarren/bin` stays, because it still has an owner.
    assert.equal(existsSync(layout.home), true)
  }
)

test('a Homebrew install is not deleted behind brew’s back', { skip: skipOnWindows }, () => {
  const cellar = join(home, 'Cellar', 'gitwarren-cli', '0.1.14', 'libexec', 'lib')
  mkdirSync(cellar, { recursive: true })
  writeFileSync(join(cellar, 'gitwarren.cjs'), '// poured\n')

  const layout = describeLayout('0.1.14', {
    script: join(cellar, 'gitwarren.cjs'),
    mcpServer: null
  })

  const plan = buildPlan(layout, false)
  run(plan)

  assert.equal(existsSync(join(cellar, 'gitwarren.cjs')), true)
  assert.ok(plan.notes.some((note) => /brew uninstall gitwarren-cli/.test(note)))
})

test('a checkout has nothing to uninstall and says so', { skip: skipOnWindows }, () => {
  const plan = buildPlan(describeLayout('0.0.0-dev', { script: null, mcpServer: null }), false)

  assert.deepEqual(plan.steps, [])
  assert.ok(plan.notes.some((note) => /source checkout/.test(note)))
})
