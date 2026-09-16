/**
 * The two generated files in `~/.gitwarren/bin`, written by the CLI.
 *
 * Three commands write them: `service install`, whose job it is; and `serve`
 * and `agent-setup`, for which they are a side effect (see `ensureLaunchers`
 * at the bottom). The app writes the MCP one on every launch, and the CLI
 * used to write it only when a login item was asked for - which sent a person
 * who wanted an agent, and not a service, to a command about logging in.
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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { getCliLauncherPath, getLauncherDirectory, getMcpLauncherPath } from '../core/mcp-launcher.js'
import { cmdQuote, cmdUnquote, shellQuote, shellUnquote } from '../core/shell-quote.js'
import { describeSelf, type SelfDescription } from './install.js'
import { isInside, type InstallLayout } from './layout.js'

const BANNER = (what: string): string[] => [
  `GitWarren ${what}. Written by the gitwarren command line, so a config or a`,
  'login item that names this path keeps working when the install moves.',
  'Generated file - rerun `gitwarren service install` to refresh it, do not edit this.'
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
 * Write one launcher if its contents would change. True when the file did not
 * exist before - the one case worth a sentence to the user.
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
function write(path: string, contents: string): boolean {
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
  return current === null
}

export interface WrittenLaunchers {
  cli: string
  /** Null when this install ships no MCP server - see `install.ts`. */
  mcp: string | null
  /** The launchers that did not exist before this call. */
  created: string[]
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
  const created: string[] = []
  const cli = getCliLauncherPath()
  if (write(cli, (posix ? posixLauncher : windowsLauncher)('CLI', self, self.script))) created.push(cli)

  let mcp: string | null = null
  if (self.mcpServer !== null) {
    mcp = getMcpLauncherPath()
    if (write(mcp, (posix ? posixLauncher : windowsLauncher)('MCP server', self, self.mcpServer)))
      created.push(mcp)
  }

  return { cli, mcp, created }
}

/**
 * The launchers, as a side effect rather than as the point.
 *
 * `service install` is the command whose whole job is to write these, and it
 * throws when it cannot. `gitwarren serve` and `gitwarren agent-setup` write
 * them the way the app does on every launch - because a person who has just
 * started GitWarren, or just asked how to point an agent at it, has said all
 * they need to for `~/.gitwarren/bin/gitwarren-mcp` to exist - and neither of
 * those may fail over it. A `serve` from a source checkout still has a page to
 * serve; what it cannot do is name a file a login shell could run again, and
 * that is a sentence on stderr, not a reason to stop.
 *
 * `describeSelf` is called here rather than by the caller so that the throw it
 * can raise - no migrations folder to name - is caught in the same place as
 * the checkout refusal. Both mean the same thing to the person reading it.
 */
export interface EnsuredLaunchers {
  /** What was written for the first time, to be said once and not again. */
  created: string[]
  /** Why nothing was written, when nothing was. Null on success. */
  refused: string | null
}

export function ensureLaunchers(): EnsuredLaunchers {
  try {
    const { created } = writeLaunchers(describeSelf())
    return { created, refused: null }
  } catch (error) {
    return { created: [], refused: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * ## Reading a launcher back
 *
 * Everything above writes. What follows reads, and it exists because of the
 * one failure this design has always been able to produce and never able to
 * see: `~/.gitwarren/bin/gitwarren-mcp` has one path per machine and two
 * programs that write it, and *neither of them removes it*. Uninstall the
 * Homebrew formula and the launcher stays, pointing into a Cellar that is
 * gone. What the user sees then is their agent reporting "MCP server failed to
 * connect", with nothing anywhere naming the cause.
 *
 * The fix is not a registry of what was installed - that is a second file to
 * go stale. It is to treat the launcher as what it already is: a statement of
 * which install answers on this machine, written in a format we control. Parse
 * it, and `doctor` can say the target is missing, `uninstall` can remove the
 * launchers that name the install it is removing, and - the part that matters
 * most - both can leave alone a launcher that names somebody else's.
 *
 * The app's `main/mcp-launch.ts` writes this file too, in three forms of its
 * own. All of them are recognised here, because "the desktop app's launcher"
 * is precisely the answer `uninstall` needs in order not to delete it.
 */

/** Both writers' banners say this, on a line of their own. */
const GENERATED_MARKER = 'Generated file'

export interface LauncherContents {
  /** The program the launcher runs: a `node`, an Electron binary, an AppImage. */
  interpreter: string
  /** The script it hands over, when it hands over one. */
  script: string | null
  /**
   * The file that has to exist for this launcher to work.
   *
   * The script, except for the AppImage form the app writes, where there is no
   * script until the image mounts itself and the `.AppImage` is the only path
   * that is true between launches. See `main/mcp-launch.ts`.
   */
  target: string
}

/** The quoted paths on a line, in order. `cmd` has no escapes; `sh` does. */
function quotedPaths(line: string, windows: boolean): string[] {
  const spans = line.match(windows ? /"[^"]*"/g : /"(?:\\.|[^"\\])*"/g) ?? []
  const unquote = windows ? cmdUnquote : shellUnquote
  return spans.map(unquote).filter((value): value is string => value !== null)
}

/**
 * What a launcher runs, or null when this is not a file GitWarren wrote.
 *
 * Null is the important return. A user is entitled to put their own script at
 * this path - it is a directory they own, and the whole point of it is that it
 * is theirs to inspect - and a command that deletes or rewrites a file it
 * cannot parse would be taking that back. So the banner is required before a
 * single byte is interpreted, and anything unrecognised is left exactly where
 * it is and reported.
 */
export function readLauncherContents(path: string): LauncherContents | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }

  // The banner as a block rather than line by line: the two writers put
  // "GitWarren" and "Generated file" on the same line and on different ones,
  // and what identifies the file is that its header says both.
  const lines = text.split(/\r?\n/)
  const header = lines.slice(0, 6).join('\n')
  if (!header.includes('GitWarren') || !header.includes(GENERATED_MARKER)) return null

  const windows = lines[0]?.startsWith('@echo off') ?? false
  // The line that runs something: `exec …` for both shell forms, and for `cmd`
  // the one before `exit /b`, which is the only one with two quoted paths on it.
  const runner = windows
    ? lines.find((line) => /%\*\s*$/.test(line))
    : lines.find((line) => /(^|\s)exec\s/.test(line))
  if (runner === undefined) return null

  const paths = quotedPaths(runner, windows)
  const interpreter = paths[0]
  if (interpreter === undefined) return null

  // `-e 'require(…)'` and no second path: the AppImage form, whose one durable
  // path is the image itself.
  const script = paths[1] ?? null
  return { interpreter, script, target: script ?? interpreter }
}

export type LauncherState =
  /** No file at all. */
  | 'missing'
  /** A file GitWarren did not write. Never touched, always reported. */
  | 'foreign'
  /** Points into the install these commands are acting on. */
  | 'this-install'
  /** Points at another GitWarren that is present - commonly the desktop app. */
  | 'other-install'
  /** Points at a file that is not there any more. This is the one that breaks agents. */
  | 'dangling'

export interface LauncherReport {
  which: 'cli' | 'mcp'
  path: string
  state: LauncherState
  /** What it points at, when we could read it. */
  target: string | null
}

/**
 * Whose launcher this is, in the only terms that make a delete safe.
 *
 * A managed install owns anything under `~/.gitwarren/daemon`, not only its own
 * version directory: `uninstall` removes that whole tree, so a launcher left
 * over from the version before is about to dangle and is ours to take with it.
 * Every other kind owns exactly its own prefix, and a checkout owns nothing -
 * `prefix` is null there, which makes every launcher somebody else's and is
 * the right answer for a command run out of a git worktree.
 */
function stateOf(target: string, layout: InstallLayout): LauncherState {
  if (!existsSync(target)) return 'dangling'

  const owned =
    (layout.prefix !== null && isInside(target, layout.prefix)) ||
    (layout.kind === 'managed' && isInside(target, layout.daemonRoot))

  return owned ? 'this-install' : 'other-install'
}

export function inspectLauncher(
  which: 'cli' | 'mcp',
  path: string,
  layout: InstallLayout
): LauncherReport {
  if (!existsSync(path)) return { which, path, state: 'missing', target: null }

  const contents = readLauncherContents(path)
  if (contents === null) return { which, path, state: 'foreign', target: null }

  return { which, path, state: stateOf(contents.target, layout), target: contents.target }
}

/** Both of them, which is what every caller actually wants. */
export function inspectLaunchers(layout: InstallLayout): LauncherReport[] {
  return [
    inspectLauncher('cli', getCliLauncherPath(), layout),
    inspectLauncher('mcp', getMcpLauncherPath(), layout)
  ]
}

/**
 * Remove the launchers that name the install being removed, and nothing else.
 *
 * `dangling` is included on purpose. A launcher pointing at a file that is
 * already gone works for nobody, and leaving it behind is how the next install
 * inherits a broken agent config; `doctor --fix` offers to repoint one instead,
 * which is the right move while an install is still there to point it at.
 */
export function removeOwnedLaunchers(layout: InstallLayout): {
  removed: string[]
  kept: LauncherReport[]
} {
  const removed: string[] = []
  const kept: LauncherReport[] = []

  for (const report of inspectLaunchers(layout)) {
    if (report.state === 'this-install' || report.state === 'dangling') {
      rmSync(report.path, { force: true })
      removed.push(report.path)
    } else if (report.state !== 'missing') {
      kept.push(report)
    }
  }

  return { removed, kept }
}
