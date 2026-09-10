/**
 * One command an agent can be pointed at, on every machine and every harness.
 *
 * ## The problem this replaces
 *
 * Until M2 the answer to "how does an agent start GitWarren's MCP server" was a
 * pair of absolute paths computed for the running install: the app's own
 * Electron binary, and a script inside its `Resources`. Correct, and unusable
 * as a written instruction. The paths differ per platform and per install
 * location, so a README could only guess at them; they are long enough that a
 * user copies them wrong; and on Linux they were not even stable between
 * launches, because an AppImage mounts itself at a fresh `/tmp/.mount_*` every
 * time - which is what the AppImage caveat in the README was about.
 *
 * So the app maintains a launcher at a path that is the same everywhere:
 * `~/.gitwarren/bin/gitwarren-mcp`, or `gitwarren-mcp.cmd` on Windows. It is
 * rewritten whenever its contents would change, so it always points at the
 * install that ran last - which is the right answer after an update, after a
 * move to a different folder, and after switching between a packaged app and a
 * development build.
 *
 * That is what makes the one-sentence agent prompt in docs/across-hosts.md
 * possible: an agent is told a command, not a configuration, and applies it to
 * whatever config format it happens to use. The same path is what M4's SSH
 * installer maintains on a remote host, so the same sentence works there.
 *
 * ## What the launcher contains
 *
 * The server is a plain script started with the app's own Electron binary in
 * Node mode. That matters because `better-sqlite3` is a native addon: it must
 * be loaded by a runtime whose ABI it was built for, and it has to resolve out
 * of the app's own unpacked `node_modules`. Using the bundled binary satisfies
 * both, and means the user needs no Node installation. The launcher is a
 * two-line wrapper around exactly that, so nothing about how the server starts
 * has changed - only how it is named.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { app } from 'electron'
import type { McpLaunchInfo } from '../shared/api.js'

/** `~/.gitwarren/bin`. The same on Windows, where `~` is the user profile. */
export function getLauncherDirectory(): string {
  return join(homedir(), '.gitwarren', 'bin')
}

export function getMcpLauncherPath(): string {
  return join(getLauncherDirectory(), process.platform === 'win32' ? 'gitwarren-mcp.cmd' : 'gitwarren-mcp')
}

/** Where the built server actually is, for this install. */
function scriptPath(): string {
  return app.isPackaged
    ? // asarUnpack keeps this file on the real filesystem so it can be spawned.
      join(process.resourcesPath, 'app.asar.unpacked', 'out', 'mcp', 'server.cjs')
    : join(app.getAppPath(), 'out', 'mcp', 'server.cjs')
}

/**
 * Quote a path for a POSIX shell's double quotes.
 *
 * An app is not usually installed somewhere with a `$` in the name, and this
 * would be pure ceremony if the file it produces were not executed by a shell
 * with the user's privileges every time an agent starts. It is cheap; the
 * failure it prevents is not.
 */
function shellQuote(value: string): string {
  return `"${value.replace(/(["$`\\])/g, '\\$1')}"`
}

/**
 * The launcher's contents for this install.
 *
 * Three forms rather than two, because Linux has two cases that share nothing.
 * A normal install - a package, or an extracted AppImage - has stable paths and
 * is written exactly like macOS. A *running* AppImage does not: everything
 * inside it lives under a mount point that will not exist next time.
 *
 * What an AppImage does have is one stable path, the `.AppImage` file itself,
 * which AppRun exports as `APPIMAGE`. So the launcher names that, and lets the
 * mount happen at run time: `AppRun` exports `APPDIR` into the process it
 * starts, so the script inside can be found relative to it. The offset from
 * `APPDIR` to the server is measured here, from this run's real paths, rather
 * than assumed - packaging decides that layout, and it is not this file's to
 * guess.
 *
 * This is what retires the "extract the AppImage first" caveat.
 */
const BANNER_LINES = [
  'GitWarren MCP server. Rewritten by GitWarren whenever the install moves,',
  'so an agent config that names this path keeps working across updates.',
  'Generated file - edit GitWarren, not this.'
]

/**
 * The banner, commented for whichever interpreter is going to read it.
 *
 * Commented *per branch* rather than once, because the comment character is not
 * the same in both. `#` is a comment to `/bin/sh` and is not one to `cmd`,
 * which tries to run it and writes
 *
 *     '#' is not recognized as an internal or external command,
 *     operable program or batch file.
 *
 * to stderr - once per banner line, on every single MCP server start. It cost
 * nothing at the protocol level, which is on stdout, but it landed in the log
 * of every Windows harness forever, and a harness strict enough to read output
 * on stderr during startup as a failed spawn would have rejected the server
 * outright.
 *
 * Worth knowing how it survived review: there was one banner string shared by
 * all three branches, correct in the two that are shell scripts, and the
 * Windows branch translated its line endings without touching its comments.
 * Nothing about reading that string suggests a platform question, and no test
 * on macOS or Linux can reach it. It was found by running the thing on Windows.
 */
function bannerFor(comment: string, eol: string): string {
  return BANNER_LINES.map((line) => `${comment} ${line}${eol}`).join('')
}

function launcherScript(): string {
  const appImage = process.env.APPIMAGE
  if (appImage) {
    // `-e` rather than a script argument: the argument would have to be an
    // absolute path, and the whole difficulty here is that there is not one
    // until the AppImage has mounted itself.
    const inside = relative(process.env.APPDIR ?? '/', scriptPath())
    return (
      '#!/bin/sh\n' +
      bannerFor('#', '\n') +
      `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(appImage)} \\\n` +
      `  -e 'require(process.env.APPDIR + "/${inside}")' "$@"\n`
    )
  }

  if (process.platform === 'win32') {
    return (
      '@echo off\r\n' +
      bannerFor('REM', '\r\n') +
      'setlocal\r\n' +
      'set "ELECTRON_RUN_AS_NODE=1"\r\n' +
      `"${process.execPath}" "${scriptPath()}" %*\r\n`
    )
  }

  return (
    '#!/bin/sh\n' +
    bannerFor('#', '\n') +
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(scriptPath())} "$@"\n`
  )
}

/**
 * Write the launcher if it is missing or out of date.
 *
 * Compared before writing rather than written unconditionally: this runs on
 * every launch, and rewriting an identical file would churn its mtime for no
 * reason - which matters on machines where something is watching `~` for
 * changes, and is free to avoid.
 *
 * Failure is returned rather than thrown. An agent that cannot be set up is a
 * real problem to show in the Agent Access panel, and not a reason for the app
 * to refuse to start.
 */
export function ensureMcpLauncher(): { path: string; error?: string } {
  const path = getMcpLauncherPath()
  const contents = launcherScript()

  try {
    let current: string | null = null
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      // Missing, which is the ordinary case on a first run.
    }

    if (current !== contents) {
      mkdirSync(getLauncherDirectory(), { recursive: true })
      writeFileSync(path, contents, 'utf8')
      console.log(`[mcp] wrote the launcher at ${path}`)
    }

    // Set every time, not only after a write: a file restored from a backup or
    // copied between machines commonly arrives without its executable bit.
    if (process.platform !== 'win32') chmodSync(path, 0o755)

    return { path }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[mcp] could not maintain the launcher', error)
    return { path, error: detail }
  }
}

/**
 * What to tell an agent.
 *
 * The command is the launcher, with no arguments and no environment, because
 * that is the whole point of it: the sentence a user pastes into an agent has
 * to be short enough to be pasted and stable enough to be worth remembering.
 * The underlying binary and script are still reported, for the Agent Access
 * panel to show and for anyone who would rather configure it by hand.
 */
export function getMcpLaunchInfo(): McpLaunchInfo {
  const script = scriptPath()
  const { path, error } = ensureMcpLauncher()

  return {
    command: path,
    args: [],
    env: {},
    available: existsSync(script) && error === undefined,
    // Stable everywhere now, AppImage included - that is what the launcher is
    // for. The field stays because M4 gains a case the launcher cannot fix: a
    // remote host whose daemon has not been installed yet.
    stable: true,
    direct: { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
    ...(error === undefined
      ? {}
      : {
          note:
            `GitWarren could not write its launcher to ${path} (${error}). Use the direct ` +
            `command below instead - it works, but it points inside this install and will ` +
            `need updating if GitWarren moves.`
        })
  }
}
