/**
 * The browser's shell: what a tab can do for the person in front of it, and an
 * honest refusal for everything else.
 *
 * `ShellApi` is the Electron-only surface (see `shared/api.ts`) - pickers,
 * revealing a path, launching an editor, the updater. A browser tab has none of
 * those, and the interesting question is not how to emulate them but which ones
 * may be answered by the *server* instead. The line, which M6 will lean on hard
 * when the phone connects to a host over the tailnet:
 *
 *  - **A fact about the host may travel.** `appInfo` is version numbers, an
 *    instance id and paths. Reading it over HTTP is not a capability.
 *  - **A capability of the host may not.** Revealing a folder or launching an
 *    editor acts on the machine the daemon is on, which is not necessarily the
 *    machine the person is at, and a request that could start a process there
 *    would make this very different software. So they are absent here, and they
 *    stay absent - the browser gets its own versions in M3.2 (a `vscode://`
 *    link, a file input) which act on the machine holding the keyboard.
 *
 * Refusals throw `AppError` rather than resolving to something empty, so the
 * UI's existing error paths show a sentence a user can act on. What is still
 * missing in M3.1 is the *shell capability flag* that lets a screen hide a
 * control instead of offering one that explains itself when pressed; that is
 * the first thing M3.2 does, and until then a toggle with no meaning in a
 * browser says so when it is used rather than before.
 */
import { AppError } from '@shared/errors'
import { WEB_PATHS } from '@shared/web'
import type { AppInfo, EditorList, ShellApi, UpdateStatus } from '@shared/api'

/** Nothing to unsubscribe from. Returned by the subscriptions a tab cannot have. */
const NO_SUBSCRIPTION = (): void => {}

/**
 * A refusal, as a rejected promise rather than a thrown error.
 *
 * The distinction matters at a bridge: every caller of these methods `await`s
 * them, and a function that throws synchronously before returning its promise
 * escapes a `.catch()` that a rejection would have landed in. So the refusals
 * are rejections, and the methods are deliberately not `async`.
 */
function unsupported<T>(what: string, instead: string): Promise<T> {
  return Promise.reject(
    new AppError('FORBIDDEN', `${what} is not available in a browser tab. ${instead}`)
  )
}

async function readAppInfo(): Promise<AppInfo> {
  // Same-origin, so the session cookie rides along without being asked for -
  // and `same-origin` is stated rather than left to the default, because the
  // default is the one thing about `fetch` that has changed under everyone's
  // feet before.
  const response = await fetch(WEB_PATHS.appInfo, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })

  if (!response.ok) {
    throw new AppError(
      'INTERNAL',
      `GitWarren could not describe this install (HTTP ${response.status}).`
    )
  }

  return (await response.json()) as AppInfo
}

const NO_EDITORS: EditorList = { editors: [], defaultId: null }

const UPDATES_UNSUPPORTED: UpdateStatus = {
  state: 'unsupported',
  reason:
    'GitWarren in a browser is updated by whatever installed it - Homebrew, npm, or the ' +
    'tarball it was unpacked from.'
}

export function createWebShell(): ShellApi {
  return {
    system: {
      // No native folder picker, and no attempt at one. The path field next to
      // the button is a text input, so a repository is added by typing or
      // pasting its path - which is also what someone reaching a remote host in
      // M4 will do, since a picker there would browse the wrong machine.
      pickDirectory: () => Promise.resolve(null),
      revealPath: () => unsupported('Revealing a folder', 'Copy the path and open it yourself.'),
      appInfo: readAppInfo,
      editors: () => Promise.resolve(NO_EDITORS),
      // False rather than a refusal: the question "does GitWarren start with
      // this machine" has a true answer for a browser tab, and it is no.
      // Turning it *on* is `gitwarren service install`, which arrives in M3.3.
      getOpenAtLogin: () => Promise.resolve(false),
      setOpenAtLogin: () =>
        unsupported('Starting at login', 'Run `gitwarren service install` on this machine.')
    },
    updates: {
      getStatus: () => Promise.resolve(UPDATES_UNSUPPORTED),
      check: () => Promise.resolve(UPDATES_UNSUPPORTED),
      installNow: () =>
        unsupported('Installing an update', 'Update GitWarren the way you installed it.'),
      subscribe: () => NO_SUBSCRIPTION
    },
    navigation: {
      // Deep links need no channel here. The route is in the hash, the router
      // already listens for `hashchange`, and a link clicked while the tab is
      // open is simply a navigation - the whole mechanism `main/deep-link.ts`
      // exists to reproduce is what a browser does natively.
      onDeepLink: () => NO_SUBSCRIPTION
    },
    pickAttachment: () => Promise.resolve(null),
    openInEditor: () =>
      unsupported('Opening a file in an editor', 'Open it from the repository on this machine.')
  }
}
