/**
 * The browser's shell: what a tab can do for the person in front of it, and an
 * honest refusal for everything else.
 *
 * `ShellApi` is the surface the dispatcher may not have (see `shared/api.ts`) -
 * pickers, revealing a path, launching an editor, the updater. A browser tab
 * has none of those natively, and the interesting question is not how to
 * emulate them but where each one may be answered from instead. The line, which
 * M6 will lean on hard when the phone connects to a host over the tailnet:
 *
 *  - **A fact about the host may travel.** `appInfo` is version numbers, an
 *    instance id and paths; `reviews.filePath` is where a file of this review
 *    lives. Reading either over the carrier is not a capability.
 *  - **A capability of the host may not.** Revealing a folder or spawning an
 *    editor acts on the machine the daemon is on, which is not necessarily the
 *    machine the person is at, and a request that could start a process there
 *    would make this very different software. So nothing here asks the server
 *    to *do* anything to its machine.
 *
 * What that leaves is a tab doing these things itself, with the browser's own
 * tools, on the machine holding the keyboard:
 *
 *  - **Attaching an image** is a file input, and the bytes go through
 *    `attachments.ingest` - the same method an agent's path goes through.
 *  - **Opening a file in an editor** is a `vscode://file/…:line` navigation.
 *    The path is asked for over the carrier and the URL is opened here, which
 *    is the same two halves `main/ipc.ts` joins, joined in the other order.
 *  - **Rendering an attachment** is a rewrite of the token to a path on this
 *    origin, which the server answers from the same store.
 *
 * Three things genuinely cannot be done, and rather than being offered and
 * explaining themselves when pressed, they are declared absent in
 * `capabilities` so the screens leave them out. The refusals below stay as the
 * backstop for a caller that did not look.
 */
import { AppError } from '@shared/errors'
import { editorLink, editorTargetFor, linkableEditors } from '@shared/editors'
import { WEB_PATHS, webAttachmentSrc } from '@shared/web'
import type { AppInfo, EditorList, ShellApi, UpdateStatus } from '@shared/api'
import type { Attachment, OpenReviewFileInput } from '@shared/schemas'
import type { WebCarrier } from './carrier'

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

/**
 * The row for one instance id, out of a list this tab has just asked for.
 *
 * A list rather than a `hosts.get`, because `hosts.get` takes the local numeric
 * id and what a route carries is the instance id - the only name that survives
 * a machine being renamed or readdressed. It is one local SQLite read behind
 * the socket and happens on a button press, so there is nothing to save by
 * caching it and something to lose: the target is the field someone edits when
 * their editor and their SSH config disagree.
 */
function requireHostRow(
  list: { instanceId: string | null; kind: string; target: string; editorTarget: string | null }[],
  instanceId: string
): { kind: string; target: string; editorTarget: string | null } {
  const row = list.find((candidate) => candidate.instanceId === instanceId)
  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `This GitWarren does not know a host with id ${instanceId}. ` +
        'It may have been removed, or the link may have come from somewhere else.'
    )
  }
  return row
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

/**
 * Every editor with a URL scheme, offered as a choice rather than as a finding.
 *
 * The Electron app lists what it detected on disk; a tab cannot look, so it
 * lists what it knows how to address and lets the reviewer say. `defaultId` is
 * the first of them, which is a guess - and the picker in the files tab appears
 * precisely because more than one entry means the guess can be corrected.
 */
function editorChoices(): EditorList {
  const editors = linkableEditors()
  return { editors, defaultId: editors[0]?.id ?? null }
}

const UPDATES_UNSUPPORTED: UpdateStatus = {
  state: 'unsupported',
  reason:
    'GitWarren in a browser is updated by whatever installed it - Homebrew, npm, or the ' +
    'tarball it was unpacked from.'
}

/**
 * The file picker, as a browser has one.
 *
 * An `<input type="file">` clicked from script, which is the only way to open a
 * file dialog on the web and is why this is not simply absent: the composer
 * already has an "attach" button, and it can go on meaning the same thing.
 *
 * Cancellation is the awkward part. A dialog that is dismissed fires `cancel`
 * in current browsers, and fired nothing at all in browsers that are still
 * around - which would leave the composer's `busy` flag set for the life of the
 * page. So `cancel` settles it when it comes, and the first `focus` back on the
 * window is the fallback: whichever happens first wins, and `change` beats both
 * because it is dispatched before focus returns.
 */
function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/gif,image/webp'
    // Off-screen rather than `display:none`: a hidden input is not clickable in
    // every browser, and the click is the whole point.
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.append(input)

    let settled = false
    const settle = (file: File | null): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(file)
    }

    // A frame's grace after focus comes back, so a `change` that is already on
    // its way is not overtaken by the fallback.
    const onFocus = (): void => {
      window.setTimeout(() => settle(input.files?.[0] ?? null), 300)
    }

    input.addEventListener('change', () => settle(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => settle(null))
    window.addEventListener('focus', onFocus)

    input.click()
  })
}

/**
 * `WebCarrier` rather than `Carrier`, since M4.5.
 *
 * The extra two methods are `connected` and `onConnectionChange`, and they are
 * the whole reason this shell can answer a question the preload's cannot: a tab
 * is the one shell whose link to its own core can go away while the page stays
 * on screen. See `ShellConnection`.
 */
export function createWebShell(carrier: WebCarrier): ShellApi {
  /**
   * Ask the host where the file is, then hand the URL to this machine.
   *
   * `reviews.filePath` is a read on the dispatcher - it answers *which* file,
   * which is review knowledge - and the navigation is this shell's own. The
   * path is an absolute path on the machine that owns the review, which since
   * M4.3 may not be the machine the daemon is on; `input.host` is which, and
   * the request carries it so that the *path* comes from there.
   *
   * The URL then needs the other half, and it is a different question: the
   * browser is on the machine the person is sitting at, the loopback handler
   * having made sure of that, so the editor it hands the URL to is a local one
   * being told where the file is. That is the remote authority from S4, and it
   * comes from the host row rather than from the path.
   */
  const openInEditor = async (input: OpenReviewFileInput): Promise<void> => {
    const { id, path, changes, line, editorId, host } = input
    const editor = editorLink(editorId) ?? editorLink(editorChoices().defaultId ?? undefined)
    if (!editor?.url) {
      return unsupported(
        'Opening a file in an editor',
        'No editor with a URL scheme was chosen for this tab.'
      )
    }
    if (host !== undefined && !editor.remoteUrl) {
      return unsupported(
        'Opening a file on another machine',
        `${editor.label} has no way to open a file it cannot see. VS Code, Cursor and Windsurf do.`
      )
    }

    const absolute = await carrier.request('reviews.filePath', { id, path, changes }, host)

    // A host's own list of hosts is answered by whoever is asked, so this is
    // this install's row for that machine - which is the right one: it is the
    // row the person filled in, on the computer their editor is on.
    const remote =
      host === undefined
        ? undefined
        : editorTargetFor(requireHostRow(await carrier.request('hosts.list', undefined), host))

    // `location.href` rather than `window.open`: a scheme the browser hands to
    // the OS does not open a document, so a popup would be an empty tab left
    // behind, and a top-level navigation to an external scheme leaves this page
    // where it is. A scheme nothing has claimed shows the browser's own "no
    // application" dialog, which is a better answer than anything this code
    // could invent.
    // `line` is optional on the way in and defaulted by the schema on the way
    // through the dispatcher, which this call does not go through.
    window.location.href =
      remote === undefined
        ? editor.url(absolute, line ?? 1)
        : // Non-null because the guard above refused an editor without one, and
          // nothing between here and there can have changed which editor it is.
          editor.remoteUrl!(remote, absolute, line ?? 1)
  }

  /**
   * A picked file, ingested exactly as a pasted one is.
   *
   * The bytes go over the carrier to `attachments.ingest`, so the size limit,
   * the format sniff and the content addressing are the store's, not this
   * shell's - the same service an agent's file path reaches. The one thing a
   * tab knows that the Electron picker does not is that it never learns a path,
   * which is fine: a path was never what got stored.
   */
  const pickAttachment = async (host?: string): Promise<Attachment | null> => {
    const file = await pickImageFile()
    if (file === null) return null
    return await carrier.request(
      'attachments.ingest',
      { bytes: await file.arrayBuffer(), originalName: file.name },
      // The store that has to end up holding it is the one that owns the
      // review. This tab has bytes and no path, which is exactly the shape that
      // travels, so nothing else about the call changes.
      host
    )
  }

  return {
    capabilities: {
      // No native folder picker, and no attempt at one. The path field next to
      // where the button would be is a text input, so a repository is added by
      // typing or pasting its path - which is also what someone reaching a
      // remote host in M4 will do.
      pickDirectory: false,
      revealPath: false,
      // False rather than a refusal: the question "does GitWarren start with
      // this machine" has a true answer for a browser tab, and it is no.
      // Turning it *on* is `gitwarren service install`, which arrives in M3.3.
      openAtLogin: false
    },
    system: {
      pickDirectory: () => Promise.resolve(null),
      revealPath: () => unsupported('Revealing a folder', 'Copy the path and open it yourself.'),
      appInfo: readAppInfo,
      editors: () => Promise.resolve(editorChoices()),
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
    /**
     * The socket, as the one thing on this page that can quietly stop being
     * there.
     *
     * Passed straight through from the carrier, which has had both halves since
     * M3 with nothing subscribing to either. What makes it worth surfacing now
     * is what a drop actually does: in-flight requests are rejected, and
     * everything after that is *queued* rather than failed - so a tab whose
     * server has gone away shows the last thing it loaded, forever, with no
     * spinner and no error. It is the quietest failure in the app and the only
     * one nothing can infer from an outcome.
     */
    connection: {
      connected: () => carrier.connected(),
      subscribe: (listener) => carrier.onConnectionChange(listener)
    },
    navigation: {
      // Deep links need no channel here. The route is in the hash, the router
      // already listens for `hashchange`, and a link clicked while the tab is
      // open is simply a navigation - the whole mechanism `main/deep-link.ts`
      // exists to reproduce is what a browser does natively.
      onDeepLink: () => NO_SUBSCRIPTION
    },
    pickAttachment,
    attachmentSrc: webAttachmentSrc,
    openInEditor
  }
}
