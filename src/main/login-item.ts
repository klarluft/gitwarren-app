/**
 * Starting with the machine. Opt-in, and off until someone asks.
 *
 * An app that keeps running is only useful if it is running, and the honest way
 * to get there is to ask. It stays off by default: a code review tool that
 * added itself to a user's login items without being asked would deserve
 * everything said about it.
 *
 * Two mechanisms, because Linux has no equivalent of the other two.
 *
 * **macOS and Windows** have `app.setLoginItemSettings`, which registers an
 * `SMAppService` item and writes a `Run` registry value respectively. Only
 * Windows takes arguments, so only Windows gets `--hidden`; macOS dropped
 * `openAsHidden` when it moved to `SMAppService`, and what is left is
 * `wasOpenedAtLogin`, which the app reads on the way up and treats as the same
 * request. That is not a workaround: someone who asked GitWarren to start with
 * their machine asked for it in the menu bar, not for a window in front of
 * whatever they logged in to do.
 *
 * **Linux** has neither, and Electron's implementation there is a no-op. The
 * XDG autostart specification is what desktop environments actually read, so
 * the app writes a `.desktop` file into `~/.config/autostart` - which is what
 * GNOME, KDE and the rest look at, and what a user can inspect and delete
 * without going near GitWarren.
 *
 * Every function here reads or writes the OS, never a setting of our own. There
 * is deliberately no copy of this in the database: the login item *is* the
 * state, the user can change it from outside the app, and a mirrored copy would
 * eventually disagree with the machine it claims to describe.
 */
import { app } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HIDDEN_FLAG } from './start-hidden.js'

const DESKTOP_FILE_NAME = 'gitwarren.desktop'

/**
 * What the `Run` value is called on Windows.
 *
 * Given no `name`, Electron names it after the app user model id, which comes
 * out as `electron.app.GitWarren` - and that is what 0.1.7-beta.1 wrote. The
 * entry works perfectly under either name. What the default costs is that the
 * obvious way to check it,
 *
 *     reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v GitWarren
 *
 * reports the value missing while the feature is working, which is exactly what
 * happened the first time this was verified on Windows: the login item was
 * briefly recorded as broken on the strength of it. A name the user would guess
 * makes the obvious check the right one.
 *
 * **No migration, deliberately.** A registry entry is keyed by its name, so
 * renaming one normally means carrying it across - write the new, clear the old -
 * or a user ends up with two, the stale one still starting the app while the
 * toggle no longer controls it. Nothing to carry here: start at login arrived
 * with M2 in `v0.1.7-beta.1`, which is a draft that was never released, and the
 * newest published version - `v0.1.6` - has no `login-item.ts` and calls
 * `setLoginItemSettings` nowhere. No installed GitWarren has ever written a
 * `Run` value, so `electron.app.GitWarren` exists only on machines that ran the
 * unreleased beta. If that stops being true before this ships, the migration is
 * back on.
 */
const LOGIN_ITEM_NAME = 'GitWarren'

/**
 * The options both calls have to agree on.
 *
 * `name` and `args` are read back as part of the identity of the entry - Windows
 * looks up the value by name and compares the whole command line - so a `get`
 * that omits either reports `false` for an entry we wrote ourselves.
 */
function loginItemOptions(openAtLogin: boolean): Parameters<typeof app.setLoginItemSettings>[0] {
  const options = {
    openAtLogin,
    // Windows only - macOS ignores it, and reports `wasOpenedAtLogin` instead.
    // Passed unconditionally because an empty array is what turns a previously
    // registered `--hidden` entry back into a plain one.
    args: openAtLogin ? [HIDDEN_FLAG] : []
  }

  return process.platform === 'win32' ? { ...options, name: LOGIN_ITEM_NAME } : options
}

function autostartDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart')
}

function desktopFilePath(): string {
  return join(autostartDirectory(), DESKTOP_FILE_NAME)
}

/**
 * What to run at login on Linux.
 *
 * `APPIMAGE` when there is one, for the same reason the MCP launcher uses it:
 * it is the only path an AppImage has that will still exist next week.
 */
function linuxCommand(): string {
  return process.env.APPIMAGE ?? process.execPath
}

function desktopFile(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=GitWarren',
    'Comment=Local code review for your git repositories',
    // Started hidden: the point of a login item here is the tray icon and the
    // link server, not a window in front of whatever the user logged in to do.
    `Exec="${linuxCommand()}" ${HIDDEN_FLAG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

export function isOpenAtLogin(): boolean {
  if (process.platform === 'linux') return existsSync(desktopFilePath())
  // The same `name` and `args` have to be handed back or Windows reports
  // `openAtLogin` false for an entry it registered itself: the value is found by
  // name and matched on the whole command line, arguments included.
  return app.getLoginItemSettings(
    process.platform === 'win32' ? loginItemOptions(true) : undefined
  ).openAtLogin
}

/**
 * Turn it on or off. Returns what the machine says afterwards, not what was
 * asked for - if the write failed, the caller and the UI should be looking at
 * the truth.
 */
export function setOpenAtLogin(openAtLogin: boolean): boolean {
  try {
    if (process.platform === 'linux') {
      if (openAtLogin) {
        mkdirSync(autostartDirectory(), { recursive: true })
        writeFileSync(desktopFilePath(), desktopFile(), 'utf8')
      } else {
        rmSync(desktopFilePath(), { force: true })
      }
    } else {
      app.setLoginItemSettings(loginItemOptions(openAtLogin))
    }
  } catch (error) {
    console.error('[login-item] could not change the login item', error)
  }

  return isOpenAtLogin()
}

/**
 * Whether macOS started this launch because of the login item.
 *
 * macOS-only by construction: `wasOpenedAtLogin` is not reported anywhere else,
 * and nowhere else needs it - Windows and Linux say so with `--hidden`.
 */
export function wasOpenedAtLogin(): boolean {
  if (process.platform !== 'darwin') return false
  return app.getLoginItemSettings().wasOpenedAtLogin
}
