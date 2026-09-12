/**
 * Whether the app is on its way out.
 *
 * The window's `close` handler hides instead of closing, because since M2
 * closing a window puts GitWarren away rather than ending it - see
 * `index.ts`. That behaviour has to have an exception, or the app could never
 * quit at all: the exception is this flag, set once when a real shutdown
 * begins, and read by the handler to tell "the user is putting this away" from
 * "the app is going".
 *
 * It lives in its own module rather than as a local in `index.ts` because two
 * different things start a shutdown and only one of them is `before-quit`.
 *
 * The other is the updater, and it is the reason this file exists. Electron's
 * `autoUpdater.quitAndInstall()` does not call `app.quit()` and then close the
 * windows; it closes every window *first* and calls `app.quit()` only once
 * they are all gone. So on the update path `before-quit` fires after the
 * windows have closed - which means a flag set there arrives too late to let
 * them close. The window would refuse the close, `app.quit()` would never be
 * reached, and the app would sit there hidden, still on the old version, with
 * the installer waiting for a quit that never comes. `updater.ts` marks the
 * shutdown before it hands over, which is exactly what this module is for.
 */

let quitting = false

/** True once a real shutdown has begun, so a window close may proceed. */
export function isQuitting(): boolean {
  return quitting
}

/**
 * Declare that the app is shutting down. Idempotent: `before-quit` still fires
 * on the update path, after the windows are closed, and calling this twice is
 * the normal case rather than a mistake.
 */
export function markQuitting(): void {
  quitting = true
}
