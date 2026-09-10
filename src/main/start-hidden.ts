/**
 * Whether this launch should come up without a window.
 *
 * Two ways it can, and they arrive by completely different routes.
 *
 * **A login start.** The login item is registered with `--hidden` on Windows
 * and Linux, so the flag says so. macOS has no equivalent since it moved to
 * `SMAppService`, and reports `wasOpenedAtLogin` instead, which the caller
 * passes in. A tray app that threw a window in the user's face every time they
 * logged in would be worse than one that did not start at all.
 *
 * **A relaunch after an update.** This one has to be remembered rather than
 * passed, and that is the whole reason this file exists. `electron-updater`
 * restarts the app itself, through an installer on Windows and a script on
 * macOS, and there is no supported way to hand argv to the process that comes
 * back. So the app that is quitting leaves a note in its data directory, and
 * the app that starts reads it. A user who was running GitWarren in the tray,
 * with no window open, should get GitWarren in the tray with no window open -
 * an update is not an event they asked to be shown.
 *
 * The note is stamped with a time and ignored if it is old. A crash between
 * writing it and quitting would otherwise leave the app starting hidden
 * forever, which from the user's side looks exactly like an app that no longer
 * launches.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDataDirectory, getDataDirectory } from '../core/paths.js'

/** Passed to a login start on Windows and Linux; see `login-item.ts`. */
export const HIDDEN_FLAG = '--hidden'

const MARKER_FILE_NAME = 'relaunch-hidden'

/**
 * How long the note is worth believing.
 *
 * An update relaunch is seconds away - the installer runs and the app comes
 * back. Five minutes is generous enough to survive a slow Windows installer and
 * short enough that a note left by a crash is forgotten before the user tries
 * again.
 */
const MARKER_TTL_MS = 5 * 60 * 1000

function markerPath(): string {
  return join(getDataDirectory(), MARKER_FILE_NAME)
}

/** Called on the way out, when the app is quitting in order to come back. */
export function requestHiddenRelaunch(): void {
  try {
    ensureDataDirectory()
    writeFileSync(markerPath(), String(Date.now()), 'utf8')
  } catch (error) {
    // The update still installs; the window simply reappears. Not worth failing
    // an update over.
    console.error('[start] could not ask for a hidden relaunch', error)
  }
}

/**
 * Consumed, not merely read: whatever the answer, the note is gone afterwards,
 * so the *next* launch is an ordinary one.
 */
function takeHiddenRelaunch(): boolean {
  let stamp: number
  try {
    stamp = Number(readFileSync(markerPath(), 'utf8'))
  } catch {
    return false
  }

  try {
    rmSync(markerPath(), { force: true })
  } catch (error) {
    console.error('[start] could not clear the relaunch marker', error)
  }

  return Number.isFinite(stamp) && Date.now() - stamp < MARKER_TTL_MS
}

/**
 * The whole decision, made once at startup.
 *
 * `openedAtLogin` comes from `app.getLoginItemSettings().wasOpenedAtLogin` and
 * is macOS's own answer to the same question - there is no `--hidden` there,
 * because `SMAppService` takes no arguments. It is passed in rather than read
 * here so that this module stays free of `electron` and can be reasoned about,
 * and tested, on its own.
 *
 * A deep link beats all of it, and that is the caller's to enforce: a launch
 * that came from someone clicking a link must show them the review, whatever
 * the login item asked for.
 */
export function shouldStartHidden(argv: readonly string[], openedAtLogin = false): boolean {
  // The marker is consumed either way - a launch that was going to be hidden
  // anyway must not leave the note behind for the next one.
  const afterUpdate = takeHiddenRelaunch()
  return argv.includes(HIDDEN_FLAG) || openedAtLogin || afterUpdate
}
