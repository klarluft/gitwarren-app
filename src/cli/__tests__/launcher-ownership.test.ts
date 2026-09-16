/**
 * Reading a launcher back, and deciding whose it is.
 *
 * This is the half of the launcher module that did not exist until `update`,
 * `uninstall` and `doctor` needed it, and the reason it had to is one bug with
 * three faces: `~/.gitwarren/bin/gitwarren-mcp` has one path per machine, two
 * programs that write it, and - until now - nothing that removed it. Uninstall
 * either of them and the file stays, naming something that is gone, and the
 * only symptom is an agent reporting "MCP server failed to connect".
 *
 * So the assertions here are all about the same three sentences:
 *
 *  - what GitWarren wrote, GitWarren can read back;
 *  - a launcher that names *this* install is ours to remove;
 *  - a launcher that names another one is not, and neither is a file we did
 *    not write.
 *
 * The third is the one with teeth. A machine with the desktop app and the
 * command line on it shares that directory, and an `uninstall` that took the
 * app's launcher with it would remove agent access from an install the user
 * did not touch.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { getCliLauncherPath, getMcpLauncherPath } from '../../core/mcp-launcher.js'
import { describeLayout, type InstallLayout } from '../layout.js'
import {
  inspectLaunchers,
  readLauncherContents,
  removeOwnedLaunchers,
  writeLaunchers
} from '../launchers.js'

let home: string
const realHome = process.env.HOME
const realProfile = process.env.USERPROFILE

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gitwarren-launcher-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realProfile
  rmSync(home, { recursive: true, force: true })
})

/** A managed install at `~/.gitwarren/daemon/<version>`, with files on disk. */
function install(version: string): { layout: InstallLayout; script: string; server: string } {
  const prefix = join(home, '.gitwarren', 'daemon', version)
  mkdirSync(join(prefix, 'lib'), { recursive: true })
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  const script = join(prefix, 'lib', 'gitwarren.cjs')
  const server = join(prefix, 'lib', 'server.cjs')
  writeFileSync(script, '// a bundle\n')
  writeFileSync(server, '// a server\n')
  writeFileSync(join(prefix, 'bin', 'gitwarren'), '#!/bin/sh\n')

  return {
    layout: describeLayout(version, { script, mcpServer: server }),
    script,
    server
  }
}

test('what writeLaunchers writes, readLauncherContents reads back', () => {
  const { script, server } = install('0.1.14')
  writeLaunchers({
    node: process.execPath,
    script,
    mcpServer: server,
    env: { GITWARREN_MIGRATIONS_DIR: join(home, 'drizzle') }
  })

  const cli = readLauncherContents(getCliLauncherPath())
  const mcp = readLauncherContents(getMcpLauncherPath())

  assert.equal(cli?.interpreter, process.execPath)
  assert.equal(cli?.target, script)
  assert.equal(mcp?.target, server)
})

test('a launcher into this install is ours; one into another install is not', () => {
  const mine = install('0.1.14')
  writeLaunchers({ node: process.execPath, script: mine.script, mcpServer: mine.server, env: {} })

  // The desktop app's own form, written the way `main/mcp-launch.ts` writes it
  // - a different banner, a different interpreter, and a path nowhere near
  // `~/.gitwarren`. This is the file an `uninstall` must not touch.
  const app = join(home, 'Applications', 'GitWarren', 'server.cjs')
  mkdirSync(join(home, 'Applications', 'GitWarren'), { recursive: true })
  writeFileSync(app, '// the app\n')
  writeFileSync(
    getMcpLauncherPath(),
    '#!/bin/sh\n' +
      '# GitWarren MCP server. Rewritten by GitWarren whenever the install moves,\n' +
      '# Generated file - edit GitWarren, not this.\n' +
      `ELECTRON_RUN_AS_NODE=1 exec "/usr/lib/gitwarren/electron" "${app}" "$@"\n`
  )

  const [cli, mcp] = inspectLaunchers(mine.layout)

  assert.equal(cli?.state, 'this-install')
  assert.equal(mcp?.state, 'other-install')
  assert.equal(mcp?.target, app)

  const { removed, kept } = removeOwnedLaunchers(mine.layout)
  assert.deepEqual(removed, [getCliLauncherPath()])
  assert.deepEqual(
    kept.map((report) => report.path),
    [getMcpLauncherPath()]
  )
})

test('a launcher left over from an older version of the same install is ours too', () => {
  // `uninstall` deletes the whole of `~/.gitwarren/daemon`, so a launcher
  // pointing at the version before this one is about to dangle either way.
  const old = install('0.1.13')
  writeLaunchers({ node: process.execPath, script: old.script, mcpServer: old.server, env: {} })

  const current = install('0.1.14')
  const [cli] = inspectLaunchers(current.layout)

  assert.equal(cli?.state, 'this-install')
})

test('a launcher whose target is gone is the failure this was written for', () => {
  const brewed = join(home, 'Cellar', 'gitwarren-cli', '0.1.14', 'libexec', 'lib', 'server.cjs')
  mkdirSync(join(home, 'Cellar', 'gitwarren-cli', '0.1.14', 'libexec', 'lib'), { recursive: true })
  writeFileSync(brewed, '// poured\n')

  mkdirSync(join(home, '.gitwarren', 'bin'), { recursive: true })
  writeFileSync(
    getMcpLauncherPath(),
    '#!/bin/sh\n' +
      '# GitWarren MCP server. Written by the gitwarren command line, so a config or a\n' +
      '# Generated file - rerun `gitwarren service install` to refresh it, do not edit this.\n' +
      `exec "/usr/bin/node" "${brewed}" "$@"\n`
  )

  // `brew uninstall` - the Cellar goes, the launcher stays.
  rmSync(join(home, 'Cellar'), { recursive: true, force: true })

  const layout = describeLayout('0.1.14', { script: null, mcpServer: null })
  const [, mcp] = inspectLaunchers(layout)

  assert.equal(mcp?.state, 'dangling')
  assert.equal(mcp?.target, brewed)

  // Removable even from a checkout, which owns nothing: a launcher that starts
  // nothing works for no install at all, so nobody's is being taken away.
  const { removed } = removeOwnedLaunchers(layout)
  assert.deepEqual(removed, [getMcpLauncherPath()])
})

test('a file GitWarren did not write is reported and left exactly where it is', () => {
  mkdirSync(join(home, '.gitwarren', 'bin'), { recursive: true })
  const mine = '#!/bin/sh\nexec /usr/local/bin/my-own-wrapper "$@"\n'
  writeFileSync(getMcpLauncherPath(), mine)
  chmodSync(getMcpLauncherPath(), 0o755)

  const layout = describeLayout('0.1.14', { script: null, mcpServer: null })
  const [, mcp] = inspectLaunchers(layout)

  assert.equal(mcp?.state, 'foreign')
  assert.equal(mcp?.target, null)

  const { removed, kept } = removeOwnedLaunchers(layout)
  assert.deepEqual(removed, [])
  assert.equal(kept[0]?.state, 'foreign')
  assert.equal(readLauncherContents(getMcpLauncherPath()), null)
})

test('the app AppImage form parses to the image, which is the path that stays true', () => {
  // There is no script until the image mounts itself, so the `.AppImage` is
  // the file whose absence means the launcher is broken. See `mcp-launch.ts`.
  mkdirSync(join(home, '.gitwarren', 'bin'), { recursive: true })
  writeFileSync(
    getMcpLauncherPath(),
    '#!/bin/sh\n' +
      '# GitWarren MCP server. Rewritten by GitWarren whenever the install moves,\n' +
      '# Generated file - edit GitWarren, not this.\n' +
      'ELECTRON_RUN_AS_NODE=1 exec "/home/x/Apps/GitWarren.AppImage" \\\n' +
      '  -e \'require(process.env.APPDIR + "/out/mcp/server.cjs")\' "$@"\n'
  )

  assert.equal(readLauncherContents(getMcpLauncherPath())?.target, '/home/x/Apps/GitWarren.AppImage')
})

test('the Windows form parses on every platform, because that is where it is read', () => {
  // A `.cmd` is only *run* on Windows, and is read here by a test suite that
  // mostly runs on Linux - the parser has no platform branch for that reason.
  mkdirSync(join(home, '.gitwarren', 'bin'), { recursive: true })
  const path = join(home, '.gitwarren', 'bin', 'gitwarren-mcp.cmd')
  writeFileSync(
    path,
    '@echo off\r\n' +
      'REM GitWarren MCP server. Written by the gitwarren command line, so a config or a\r\n' +
      'REM Generated file - rerun `gitwarren service install` to refresh it, do not edit this.\r\n' +
      'setlocal\r\n' +
      'set "GITWARREN_MIGRATIONS_DIR=C:\\Users\\x\\.gitwarren\\daemon\\0.1.14\\drizzle"\r\n' +
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\.gitwarren\\daemon\\0.1.14\\lib\\server.cjs" %*\r\n' +
      'exit /b %ERRORLEVEL%\r\n'
  )

  const contents = readLauncherContents(path)

  assert.equal(contents?.interpreter, 'C:\\Program Files\\nodejs\\node.exe')
  assert.equal(contents?.target, 'C:\\Users\\x\\.gitwarren\\daemon\\0.1.14\\lib\\server.cjs')
})

test('a quoted path with a dollar in it survives the round trip', () => {
  const { layout } = install('0.1.14')
  const odd = join(home, '.gitwarren', 'daemon', '0.1.14', 'lib', 'a $b `c`.cjs')
  writeFileSync(odd, '// odd\n')
  writeLaunchers({ node: process.execPath, script: odd, mcpServer: null, env: {} })

  assert.equal(readLauncherContents(getCliLauncherPath())?.target, odd)
  assert.equal(inspectLaunchers(layout)[0]?.state, 'this-install')
})
