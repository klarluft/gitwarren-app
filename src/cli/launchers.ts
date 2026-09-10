/**
 * The two generated files in `~/.gitwarren/bin`, written by the CLI.
 *
 * `main/mcp-launch.ts` does the same job for the app, and the duplication is
 * deliberate rather than missed: what the two write is genuinely different -
 * the app names its own Electron binary in Node mode, the CLI names a real
 * `node` and a real bundle - and the only thing they must agree on is the
 * *path*, which is why that is the one part that lives in
 * `core/mcp-launcher.ts` and is imported by both.
 *
 * ## They overwrite each other, and that is the design
 *
 * `gitwarren-mcp` has one path per machine and can only point at one install.
 * A machine with both the app and the CLI will have whichever ran last, and
 * both work: each launcher starts a server against the same database, because
 * `core/paths.ts` is what decides where that is. The alternative - two names,
 * so nothing is ever overwritten - would mean the one-sentence agent prompt has
 * to ask which kind of GitWarren the user installed, and that sentence is the
 * whole point of the launcher. Last writer wins is the cheaper wrong answer.
 *
 * `gitwarren` itself has no such competitor: the app has no CLI to offer.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { getCliLauncherPath, getLauncherDirectory, getMcpLauncherPath } from '../core/mcp-launcher.js'
import { cmdQuote, shellQuote } from '../core/shell-quote.js'
import type { SelfDescription } from './install.js'

const BANNER = (what: string): string[] => [
  `GitWarren ${what}. Written by \`gitwarren service install\`, so a config or a`,
  'login item that names this path keeps working when the install moves.',
  'Generated file - run the command again, do not edit this.'
]

/**
 * The banner, commented for whichever interpreter reads it.
 *
 * Per branch rather than once, because `#` is a comment to `/bin/sh` and is not
 * one to `cmd`, which tries to run it and complains to stderr for every line.
 * `main/mcp-launch.ts` has the long version of this story: it shipped with one
 * shared banner string, correct on two platforms, and was only found by running
 * the thing on Windows.
 */
function bannerFor(what: string, comment: string, eol: string): string {
  return BANNER(what)
    .map((line) => `${comment} ${line}${eol}`)
    .join('')
}

function posixLauncher(what: string, self: SelfDescription, script: string): string {
  const exports = Object.entries(self.env)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join('')

  return (
    '#!/bin/sh\n' +
    bannerFor(what, '#', '\n') +
    exports +
    `exec ${shellQuote(self.node)} ${shellQuote(script)} "$@"\n`
  )
}

/**
 * `%*` rather than `"$@"`, and no `exec` - `cmd` has neither.
 *
 * The exit code has to be forwarded by hand as a result: without the final
 * `exit /b`, the batch file returns the code of the last *batch* statement,
 * which is not the program's. A harness that spawns this and reads the exit
 * status would see success for a server that failed to start.
 */
function windowsLauncher(what: string, self: SelfDescription, script: string): string {
  const sets = Object.entries(self.env)
    .map(([name, value]) => `set "${name}=${value}"\r\n`)
    .join('')

  return (
    '@echo off\r\n' +
    bannerFor(what, 'REM', '\r\n') +
    'setlocal\r\n' +
    sets +
    `${cmdQuote(self.node)} ${cmdQuote(script)} %*\r\n` +
    'exit /b %ERRORLEVEL%\r\n'
  )
}

/**
 * Write one launcher if its contents would change.
 *
 * Compared before writing for the reason `ensureMcpLauncher` gives: this is a
 * file in the user's home directory, and churning its mtime for an identical
 * body is free to avoid on machines where something is watching `~`.
 *
 * The `chmod` happens whether or not anything was written, because a file
 * restored from a backup or copied between machines commonly arrives without
 * its executable bit, and a login item pointing at a non-executable file fails
 * in a way that names neither.
 */
function write(path: string, contents: string): void {
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // Missing, which is the ordinary case the first time.
  }

  if (current !== contents) {
    mkdirSync(getLauncherDirectory(), { recursive: true })
    writeFileSync(path, contents, 'utf8')
  }
  if (process.platform !== 'win32') chmodSync(path, 0o755)
}

export interface WrittenLaunchers {
  cli: string
  /** Null when this install ships no MCP server - see `install.ts`. */
  mcp: string | null
}

/**
 * Put both launchers where every other part of GitWarren says they are.
 *
 * Throws rather than reporting, unlike the app's version. The app writes these
 * on every launch and must not refuse to start over one; this is a command
 * somebody typed, whose entire job is to write them, and a failure is the
 * answer rather than a footnote to a success.
 */
export function writeLaunchers(self: SelfDescription): WrittenLaunchers {
  if (self.script === null) {
    throw new Error(
      'this gitwarren is running from a source checkout, so there is no single file a ' +
        'login item could name. Build it first (`npm run build:daemon`), or install ' +
        'GitWarren from a tarball, Homebrew or npm.'
    )
  }

  const posix = process.platform !== 'win32'
  const cli = getCliLauncherPath()
  write(cli, (posix ? posixLauncher : windowsLauncher)('CLI', self, self.script))

  let mcp: string | null = null
  if (self.mcpServer !== null) {
    mcp = getMcpLauncherPath()
    write(mcp, (posix ? posixLauncher : windowsLauncher)('MCP server', self, self.mcpServer))
  }

  return { cli, mcp }
}
