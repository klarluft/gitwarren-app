/**
 * `gitwarren service install` - GitWarren starting with the machine, without a
 * GitWarren.app to do it.
 *
 * The tray app has had this since M2 (`main/login-item.ts`), and since M3.2 the
 * browser shell has had a switch that refuses and names this command by name.
 * This is the file that makes that sentence true.
 *
 * ## What "install" means here
 *
 * Two things, and they are worth separating because only one of them is about
 * logging in:
 *
 *  1. **The launchers.** `~/.gitwarren/bin/gitwarren` and `gitwarren-mcp`, at
 *     the paths every other part of GitWarren already names - the Agent Access
 *     panel prints the second as a command to paste, and M4 spawns the first
 *     over ssh. Written every time, so running this after an update points them
 *     at the install that ran last.
 *  2. **The login item.** A LaunchAgent, a `systemd --user` unit or an at-logon
 *     Scheduled Task, each running `gitwarren serve --listen`.
 *
 * The first is useful on a machine that will never want the second - a VPS
 * where an agent works and nobody opens a browser - so `--no-login-item` stops
 * after it.
 *
 * ## It is opt-in, and it says what it did
 *
 * Nothing here runs unless somebody typed it, and everything it writes is a
 * file the user can read and delete without going near GitWarren: that is the
 * same bargain `main/login-item.ts` struck, and a CLI has less excuse than a
 * GUI to be quiet about it. Every path written is printed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { getCliLauncherPath, getMcpLauncherPath } from '../core/mcp-launcher.js'
import { getDataDirectory } from '../core/paths.js'
import { describeSelf } from './install.js'
import { writeLaunchers } from './launchers.js'
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_TASK,
  launchAgent,
  systemdUnit,
  windowsTaskCommand
} from './units.js'

const USAGE = `gitwarren service install [--no-login-item]
gitwarren service uninstall
gitwarren service status

install    keeps GitWarren running in the background: it starts now, and again
           at every login, so \`gitwarren open\` and the links an agent hands
           you always have something to open. Registers a LaunchAgent on
           macOS, a systemd user unit on Linux, an at-logon task on Windows.
           Also writes ~/.gitwarren/bin/gitwarren and gitwarren-mcp, the
           stable paths the app and an agent start this install by.
           --no-login-item writes those two files and registers nothing,
           for a machine that is only ever reached from another one.
uninstall  stops the background GitWarren and removes the login item. The two
           files in ~/.gitwarren/bin stay, because an agent config may name
           one - \`gitwarren uninstall\` is the command that removes GitWarren
           from this machine entirely.
status     what is registered, what is running, and where the data is.
`

/** `~/Library/Logs/GitWarren/daemon.log`. macOS only - see `units.ts`. */
function macLogPath(): string {
  return join(homedir(), 'Library', 'Logs', 'GitWarren', 'daemon.log')
}

/**
 * Where the login item is defined, or null on Windows.
 *
 * Windows keeps its at-logon tasks in a store rather than a file the user
 * edits, so there is nothing to name - which is why every Windows branch below
 * goes through `schtasks` and the other two write a file and then tell the OS
 * to read it.
 */
function unitPath(): string | null {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    case 'win32':
      return null
    default:
      return join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
        'systemd',
        'user',
        SYSTEMD_UNIT
      )
  }
}

/**
 * Run a platform tool, returning its output or null when it failed.
 *
 * Null rather than a throw because every caller here is asking a question the
 * OS is allowed to answer with "no such thing": `launchctl print` on an
 * unloaded label and `schtasks /Query` on a missing task both exit non-zero,
 * and that *is* the answer rather than an error to report.
 *
 * stderr is swallowed for the same reason - `systemctl --user` outside a user
 * session prints a paragraph about `XDG_RUNTIME_DIR` that would drown the
 * sentence this command is trying to say.
 */
function ask(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** Run a platform tool that is expected to work, and say what it said if not. */
function must(command: string, args: readonly string[]): void {
  try {
    execFileSync(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`\`${command} ${args.join(' ')}\` failed: ${detail}`, { cause: error })
  }
}

/** The `gui/<uid>` domain a modern `launchctl` wants. `sudo` is never involved. */
function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`
}

function registerLoginItem(launcher: string): string {
  const path = unitPath()

  if (process.platform === 'win32') {
    // `/F` so a reinstall replaces the task rather than failing on the name,
    // which is the ordinary case after an update. No `/RU`, no `/RL HIGHEST`:
    // this runs as the logged-in user with their own privileges, and a code
    // review tool asking for more would deserve to be asked why.
    must('schtasks', [
      '/Create',
      '/TN',
      WINDOWS_TASK,
      '/TR',
      windowsTaskCommand(launcher),
      '/SC',
      'ONLOGON',
      '/F'
    ])
    // Started now as well as at logon, for the reason the systemd branch gives
    // `--now`: the command a user just typed should have a visible effect, and
    // "log out and back in" is not one. `ask` rather than `must` because a
    // task that refuses to run this instant is still registered.
    ask('schtasks', ['/Run', '/TN', WINDOWS_TASK])
    return `Scheduled Task "${WINDOWS_TASK}"`
  }

  if (path === null) throw new Error('no login item path for this platform')
  mkdirSync(dirname(path), { recursive: true })

  if (process.platform === 'darwin') {
    mkdirSync(dirname(macLogPath()), { recursive: true })
    writeFileSync(path, launchAgent(launcher, macLogPath()), 'utf8')
    // Unloaded first so a reinstall re-reads the file. `bootout` on a label
    // that is not loaded is an error, and an expected one - hence `ask`.
    ask('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`])
    must('launchctl', ['bootstrap', launchdDomain(), path])
    return path
  }

  writeFileSync(path, systemdUnit(launcher), 'utf8')
  must('systemctl', ['--user', 'daemon-reload'])
  // `enable` is what makes it start at the next login; `--now` starts it for
  // this one, so the command a user just typed has a visible effect.
  must('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
  return path
}

export function removeLoginItem(): string {
  if (process.platform === 'win32') {
    ask('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'])
    return `Scheduled Task "${WINDOWS_TASK}"`
  }

  const path = unitPath()
  if (path === null) throw new Error('no login item path for this platform')

  if (process.platform === 'darwin') {
    ask('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`])
  } else {
    ask('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
  }
  rmSync(path, { force: true })
  return path
}

/**
 * Whether the OS has a login item at all, for the two commands that have to
 * act on one they did not register.
 *
 * `loginItemState` below answers the same question in a sentence for a person
 * to read; this answers it as a fact, because `uninstall` has to decide
 * whether to remove one and `update` has to decide whether to restart one.
 * Asking the OS rather than looking for the file: on Windows there is no file,
 * and on the other two a unit that was written and never loaded is a thing
 * `uninstall` should still clean up.
 */
export function isLoginItemRegistered(): boolean {
  if (process.platform === 'win32') {
    return ask('schtasks', ['/Query', '/TN', WINDOWS_TASK]) !== null
  }
  const path = unitPath()
  return path !== null && existsSync(path)
}

/**
 * Restart the background GitWarren, so an update takes effect now.
 *
 * This is the step `install.sh` cannot take and therefore never took: it
 * finishes by writing launchers, which point at the new install, while the
 * daemon that is *already running* goes on serving the old code until the next
 * login. On macOS the reinstall happened to fix it - `bootout` then
 * `bootstrap` is a restart - and on Linux and Windows it did not, so an update
 * silently did nothing until the user logged out. Whoever runs `gitwarren
 * update` has said plainly enough that they want the new version now.
 *
 * Only ever a restart of something already running: `try-restart` on systemd,
 * and on Windows a task that is not running is not started. A machine whose
 * user stopped the service meant to stop it, and an update is not consent to
 * start it again.
 *
 * Null when there was nothing to restart, which is the ordinary case on a host
 * installed with `--no-login-item`.
 */
export function restartLoginItem(): string | null {
  if (!isLoginItemRegistered()) return null

  if (process.platform === 'win32') {
    // `/End` on a task that is not running exits non-zero and means "there was
    // nothing running", which is why this is `ask` and why the result decides
    // whether to start it again.
    if (ask('schtasks', ['/End', '/TN', WINDOWS_TASK]) === null) return null
    ask('schtasks', ['/Run', '/TN', WINDOWS_TASK])
    return `Scheduled Task "${WINDOWS_TASK}"`
  }

  if (process.platform === 'darwin') {
    // `kickstart -k` stops and starts in one step, and reports failure for a
    // label that is not loaded - which is the "nothing to restart" case.
    return ask('launchctl', ['kickstart', '-k', `${launchdDomain()}/${LAUNCHD_LABEL}`]) === null
      ? null
      : LAUNCHD_LABEL
  }

  if (ask('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]) === null) return null
  ask('systemctl', ['--user', 'try-restart', SYSTEMD_UNIT])
  return SYSTEMD_UNIT
}

/** Whether the OS says the login item is registered, and how it knows. */
export function loginItemState(): string {
  if (process.platform === 'win32') {
    return ask('schtasks', ['/Query', '/TN', WINDOWS_TASK]) === null
      ? 'not registered'
      : `registered as the Scheduled Task "${WINDOWS_TASK}"`
  }

  const path = unitPath()
  if (path === null || !existsSync(path)) return 'not registered'

  const loaded =
    process.platform === 'darwin'
      ? ask('launchctl', ['print', `${launchdDomain()}/${LAUNCHD_LABEL}`]) !== null
      : ask('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT]) !== null

  return `${path} (${loaded ? 'loaded' : 'written, but the OS has not loaded it'})`
}

function install(argv: readonly string[]): boolean {
  const self = describeSelf()
  const { cli, mcp } = writeLaunchers(self)

  console.log(`wrote ${cli}`)
  if (mcp) console.log(`wrote ${mcp}`)
  else
    console.log(
      'no MCP server next to this install, so no gitwarren-mcp launcher was written. ' +
        'An agent on this machine has nothing to start yet.'
    )

  // The login item is `serve --listen`, which needs a renderer to serve. Said
  // before the item is registered rather than after, because the alternative is
  // a user finding out at their next login by way of a log file.
  if (!('GITWARREN_WEB_ROOT' in self.env)) {
    console.log(
      '\nNo web build next to this install, so `gitwarren serve` has no page to serve. ' +
        'The protocol and the MCP server work; the browser view does not.'
    )
  }

  if (argv.includes('--no-login-item')) {
    console.log('Nothing was registered to start at login (--no-login-item).')
    return true
  }

  // Whoever holds the data directory *before* the item is registered, because
  // registering starts the daemon, and a moment later the answer would be
  // "the daemon" whether or not it is about to stand aside.
  const owner = readLiveDaemonRuntime()

  console.log(`registered ${registerLoginItem(cli)}`)

  // Said after the fact rather than as a refusal. The user asked for a login
  // item and now has one; what they also have is an app that will win the race
  // for the port every time, and finding that out in three weeks by wondering
  // why the daemon is never up is worse than a sentence now.
  if (owner?.owner === 'gui') {
    console.log(
      '\nThe desktop app is running and owns this data directory, so the background ' +
        'GitWarren has stood aside for now. Only one can serve at a time; the login item ' +
        'does its job on the logins where you do not open the app.'
    )
  } else if (owner !== null) {
    console.log(
      '\nA `gitwarren serve` is already running in a terminal, so the background GitWarren ' +
        'has stood aside for now. Stop that one and it takes over at the next login, or ' +
        'straight away if you run `gitwarren service install` again.'
    )
  } else {
    console.log(
      '\nGitWarren is now running in the background, and will start again when you log in. ' +
        '`gitwarren open` opens it in your browser; `gitwarren service uninstall` undoes ' +
        'all of this.'
    )
  }

  console.log(`\nData directory: ${getDataDirectory()}`)
  return true
}

export function runService(argv: readonly string[]): boolean {
  const [subcommand, ...rest] = argv

  try {
    switch (subcommand) {
      case 'install':
        return install(rest)

      case 'uninstall':
        console.log(`removed ${removeLoginItem()}`)
        console.log(
          'GitWarren no longer runs in the background or starts at login. `gitwarren serve` ' +
            'still runs it in a terminal. The two files in ~/.gitwarren/bin were left alone, ' +
            'because an agent config may name one - `gitwarren uninstall` removes those, and ' +
            'GitWarren itself, in one step.'
        )
        return true

      case 'status': {
        const owner = readLiveDaemonRuntime()
        const mcp = getMcpLauncherPath()
        console.log(`Login item:    ${loginItemState()}`)
        console.log(`CLI launcher:  ${existsSync(getCliLauncherPath()) ? getCliLauncherPath() : 'not written'}`)
        console.log(`MCP launcher:  ${existsSync(mcp) ? mcp : 'not written - `gitwarren agent-setup` writes it'}`)
        console.log(
          `Running now:   ${
            owner === null
              ? 'nothing - `gitwarren serve` runs it in this terminal'
              : `${owner.owner === 'gui' ? 'the desktop app' : 'gitwarren serve'} (pid ${owner.pid})`
          }`
        )
        console.log(`Data:          ${getDataDirectory()}`)
        return true
      }

      default:
        console.error(USAGE)
        return false
    }
  } catch (error) {
    console.error(`[gitwarren] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return true
  }
}
