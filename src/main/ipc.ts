/**
 * The Electron carrier.
 *
 * Two kinds of channel are registered here, and the difference between them is
 * the whole shape of M1.
 *
 * **The carrier.** `rpc:request` takes a `{method, params}` and hands it to the
 * dispatcher. That is the entire implementation. Everything that used to be a
 * handler in this file - what a valid review is, who a comment belongs to, how
 * an error is coded - now lives in `core/rpc/dispatcher.ts`, where the daemon
 * and every carrier after it will read it from too. The per-object channels
 * below are kept and still answer, each a one-line delegation to the same
 * dispatcher, so nothing that spoke to this app before M1 stopped being spoken
 * to; the renderer no longer uses them.
 *
 * **The shell.** Folder pickers, revealing a path, launching an editor, the
 * updater. These do things to the machine the person is sitting at, they stay
 * here, and they must never become methods - in M4 the far end of a carrier is
 * a daemon on another machine, and a request that could open a window or start
 * a process there would be a very different piece of software.
 *
 * If you find yourself adding logic to either kind, it almost certainly belongs
 * in a service instead.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { dispatch } from '../core/rpc/dispatcher.js'
import { route } from '../core/hosts/router.js'
import { traced } from '../core/trace.js'
import { attachmentsService, MAX_ATTACHMENT_BYTES } from '../core/services/attachments.js'
import { requireInstance } from '../core/services/hosts.js'
import { editorTargetFor } from '../shared/editors.js'
import { AppError } from '../shared/errors.js'
import { parseWithSchema as parse } from '../shared/validation.js'
import { openReviewFileInputSchema, pickAttachmentInputSchema } from '../shared/schemas.js'
import { CHANNEL_METHODS, IPC_CHANNELS, type AppInfo } from '../shared/api.js'
import type { RpcMethod, RpcOutcome, RpcParams } from '../shared/rpc.js'
import { describeInstall } from './app-info.js'
import { listEditors, openInEditor } from './editors.js'
import { isOpenAtLogin, setOpenAtLogin } from './login-item.js'
import { checkForUpdates, getUpdateStatus, quitAndInstall } from './updater.js'

/**
 * Wraps a handler so a failure arrives in the renderer as structured data
 * rather than as Electron's flattened "Error invoking remote method" string.
 *
 * The envelope is the protocol's own `RpcOutcome`, not an Electron-shaped one:
 * the same `{result} | {error}` a stdio pipe or a WebSocket will carry, so the
 * preload's unwrapping is the unwrapping every carrier does.
 */
function handle<T>(channel: string, handler: (payload: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, payload: unknown): Promise<RpcOutcome<T>> => {
    try {
      return { result: await handler(payload) }
    } catch (error) {
      // Codes, messages and field errors are preserved on the way through; the
      // dispatcher logs the unexpected ones, so that it happens the same way
      // for every carrier.
      return { error: AppError.from(error).toSerialized() }
    }
  })
}

/**
 * A shell channel, traced.
 *
 * The dispatcher traces every method it answers, so the carrier channels above
 * need nothing. These do: they are not methods, but they are still a round trip
 * the renderer paid for, and a count that left them out would be measuring the
 * wrong thing. See `core/trace.ts`.
 */
function handleShell<T>(channel: string, handler: (payload: unknown) => Promise<T> | T): void {
  handle(channel, (payload) => traced(channel, () => handler(payload)))
}

export function registerIpcHandlers(): void {
  // The carrier. Everything the renderer does arrives here.
  handle(IPC_CHANNELS.rpcRequest, (payload) => {
    if (typeof payload !== 'object' || payload === null || !('method' in payload)) {
      throw new AppError('INVALID_INPUT', 'A request needs a method.')
    }
    const { method, params, host } = payload as {
      method: RpcMethod
      params?: unknown
      host?: string
    }
    // `route` rather than `dispatch`: since M4.3 the renderer may be looking at
    // a screen that belongs to another machine, and which machine that is
    // arrives on the envelope. Everything with no host on it - which is nearly
    // everything - reaches the same dispatcher it always did.
    return route(host, method, params as RpcParams<RpcMethod>)
  })

  // Every channel that existed before M1, still answering, now through the
  // dispatcher. The table lives in `shared/api.ts` next to the channel names.
  // Deliberately not routed: these are the pre-M1 shape, one channel per
  // method with the params as the whole payload, and there is nowhere in that
  // shape to put a host. They mean what they have always meant - this machine.
  for (const [channel, method] of Object.entries(CHANNEL_METHODS)) {
    // `RpcParams<typeof method>` rather than `RpcParams<RpcMethod>`: the table
    // covers only the pre-M1 channels, so the params union here is the smaller
    // one. Widening it to every method made this stop compiling the moment M4
    // added a method no legacy channel maps to.
    handle(channel, (payload) => dispatch(method, payload as RpcParams<typeof method>))
  }

  // ---------------------------------------------------------------------------
  // The shell. Everything below this line does something to this machine.
  // ---------------------------------------------------------------------------

  // Two steps rather than one: *which* file on disk is review knowledge and
  // belongs to whoever owns the review - a method, so that in M4 it can be a
  // host across the network - while launching an application is a capability
  // only the machine with the screen on it has.
  handleShell(IPC_CHANNELS.reviewsOpenInEditor, async (input) => {
    const { id, path, changes, line, editorId, host } = parse(openReviewFileInputSchema, input)
    // `route` rather than `dispatch`, which is the whole of M4.4 here: the
    // review id means something on the machine that owns it, and asking this
    // install for `reviews.filePath` of a remote id is the bug M4.3 found by
    // pressing the button. The path that comes back is on that filesystem.
    const absolute = await route(host, 'reviews.filePath', { id, path, changes })
    // And this is the other half: the editor is on *this* machine and has to be
    // told which computer the path belongs to, because to it `/home/xfor/…` is
    // a local path that happens not to exist.
    const remote = host === undefined ? undefined : editorTargetFor(requireInstance(host))
    await openInEditor(absolute, line, editorId, remote)
  })

  // The native picker is the shell's; what it picks goes through the same
  // service an agent's file path goes through, so both produce the same row and
  // the same token. Not a dispatcher method, because it opens a window.
  handleShell(IPC_CHANNELS.attachmentsPick, async (input) => {
    const { host } = parse(pickAttachmentInputSchema, input)
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Attach an image',
      buttonLabel: 'Attach',
      properties: ['openFile'],
      // A convenience for the dialog only. What the file actually is gets
      // decided by sniffing its bytes, which is the check that matters.
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : (result.filePaths[0] ?? null)
    if (path === null) return null
    if (host === undefined) return await attachmentsService.ingest({ path })

    // A path is only a name on the machine that holds the file, so what travels
    // is bytes - the same shape a pasted screenshot has had since M1, and the
    // reason `AttachmentIngestParams` takes either. The size is checked from
    // the stat rather than after reading, exactly as the store does, so a wrong
    // file is refused without being pulled into memory on its way to a wire.
    const { size } = statSync(path)
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new AppError(
        'INVALID_INPUT',
        `That file is ${Math.round(size / 1024 / 1024)} MB. Attachments are limited to ` +
          `${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`
      )
    }
    return await route(host, 'attachments.ingest', {
      bytes: readFileSync(path),
      originalName: basename(path)
    })
  })

  handleShell(IPC_CHANNELS.systemPickDirectory, async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a git repository',
      buttonLabel: 'Add repository',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handleShell(IPC_CHANNELS.systemRevealPath, async (input) => {
    if (typeof input !== 'string' || !input) {
      throw new AppError('INVALID_INPUT', 'A path is required.')
    }
    const failure = await shell.openPath(input)
    if (failure) throw new AppError('PATH_NOT_FOUND', failure)
  })

  handleShell(IPC_CHANNELS.systemEditors, () => listEditors())

  // Starting with the machine is a property of the machine, not of the app, so
  // both of these read it back from the OS rather than from anything we store.
  handleShell(IPC_CHANNELS.systemGetOpenAtLogin, () => isOpenAtLogin())

  handleShell(IPC_CHANNELS.systemSetOpenAtLogin, (input) => {
    if (typeof input !== 'boolean') {
      throw new AppError('INVALID_INPUT', 'Start at login is on or off.')
    }
    return setOpenAtLogin(input)
  })

  handleShell(IPC_CHANNELS.systemAppInfo, (): AppInfo => describeInstall())

  handleShell(IPC_CHANNELS.updatesGetStatus, () => getUpdateStatus())
  handleShell(IPC_CHANNELS.updatesCheck, () => checkForUpdates({ userInitiated: true }))
  handleShell(IPC_CHANNELS.updatesInstallNow, () => quitAndInstall())
}
