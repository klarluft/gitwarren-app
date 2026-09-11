/**
 * The only bridge between the renderer and the main process.
 *
 * The renderer has no Node access; it gets exactly what is exposed here and
 * nothing else. Since M1 that is two things: a carrier, and the handful of
 * capabilities only this shell has.
 *
 * The carrier is one function over one channel. It is deliberately not a method
 * per object any more - the list of methods lives in `shared/rpc.ts`, and a
 * preload that had to be edited every time one was added would be a third place
 * to keep the same list.
 *
 * ## What it deliberately does not do any more: throw
 *
 * The carrier used to unwrap the outcome here, so that a failure arrived in
 * React as a thrown `AppError`. It does not, and the reason is a property of
 * `contextBridge` that is easy to miss because nothing about it looks broken: a
 * promise rejected on this side is rebuilt in the renderer as a plain `Error`
 * carrying `message` and nothing else. `code` and `fieldErrors` were being
 * dropped on the way across, silently, which meant `errorCode(error)` was
 * always null in the packaged window and every inline form message fell back to
 * the banner - a duplicate repository path was reported at the top of the
 * dialog rather than under the input it was about.
 *
 * So the carrier hands back the `RpcOutcome` as a *value*, which crosses
 * intact, and `lib/api.ts` calls `resultOf` in the renderer's own world. It is
 * the same rule the stdio and WebSocket carriers already follow, arriving at
 * the one boundary nobody had thought of as a wire.
 *
 * The shell channels below still throw across the bridge, and that is a
 * deliberate limit rather than the fix being half-applied: nothing branches on
 * a *shell* error's code - revealing a path, launching an editor and picking a
 * file are all rendered as their message - so converting twenty signatures
 * would be churn with nothing behind it. The day one of them needs a code, it
 * takes `outcomeOf` the same way.
 *
 * It also coalesces reads. Two identical reads in flight at the same moment are
 * the same read, and answering both from one round trip is free here and worth
 * a great deal once a carrier is an `ssh` pipe. Writes are never coalesced -
 * see `READ_METHODS`.
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type AppInfo,
  type EditorList,
  type GitWarrenBridge,
  type UpdateStatus
} from '../shared/api.js'
import {
  isReadMethod,
  resultOf,
  type BridgeCarrier,
  type RpcMethod,
  type RpcOutcome,
  type RpcParams,
  type RpcResult
} from '../shared/rpc.js'
import { attachmentSrcOnHost } from '../shared/attachments.js'
import type { Attachment, OpenReviewFileInput } from '../shared/schemas.js'

/**
 * A shell channel. Unwrapped here, so these keep throwing - see the note above
 * on why that is left as it is.
 */
async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  // `invoke` is typed as `any`; the envelope shape is guaranteed by `handle()`
  // in the main process, which is the only thing that answers these channels.
  return resultOf((await ipcRenderer.invoke(channel, payload)) as RpcOutcome<T>)
}

/** The carrier's channel. The outcome is the return value, not a throw. */
async function invokeOutcome<T>(channel: string, payload?: unknown): Promise<RpcOutcome<T>> {
  return (await ipcRenderer.invoke(channel, payload)) as RpcOutcome<T>
}

/**
 * Reads in flight, by method and params. An entry lives exactly as long as the
 * request it stands for - long enough to be joined, never long enough to be a
 * cache. A caller that wants a cache has SWR.
 */
const inFlight = new Map<string, Promise<unknown>>()

const carrier: BridgeCarrier = {
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    host?: string
  ): Promise<RpcOutcome<RpcResult<M>>> {
    const send = (): Promise<RpcOutcome<RpcResult<M>>> =>
      invokeOutcome<RpcResult<M>>(IPC_CHANNELS.rpcRequest, { method, params, host })

    if (!isReadMethod(method)) return send()

    // The host is part of the key, not a detail of it. Without it the
    // repository list of `pc-wsl` and the repository list of this Mac are the
    // same question asked twice, and the second component to ask would be
    // handed the first one's answer.
    const key = `${host ?? ''}:${method}:${JSON.stringify(params ?? null)}`
    const existing = inFlight.get(key) as Promise<RpcOutcome<RpcResult<M>>> | undefined
    if (existing) return existing

    const pending = send().finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
    return pending
  }
}

const bridge: GitWarrenBridge = {
  carrier,
  shell: {
    // A desktop app with the machine underneath it. Every one of these is true
    // and stays true; the interesting column is the browser's, in `web/shell.ts`.
    capabilities: {
      pickDirectory: true,
      revealPath: true,
      openAtLogin: true
    },
    system: {
      pickDirectory: () => invoke<string | null>(IPC_CHANNELS.systemPickDirectory),
      revealPath: (path: string) => invoke<void>(IPC_CHANNELS.systemRevealPath, path),
      appInfo: () => invoke<AppInfo>(IPC_CHANNELS.systemAppInfo),
      editors: () => invoke<EditorList>(IPC_CHANNELS.systemEditors),
      getOpenAtLogin: () => invoke<boolean>(IPC_CHANNELS.systemGetOpenAtLogin),
      setOpenAtLogin: (openAtLogin: boolean) =>
        invoke<boolean>(IPC_CHANNELS.systemSetOpenAtLogin, openAtLogin)
    },
    updates: {
      getStatus: () => invoke<UpdateStatus>(IPC_CHANNELS.updatesGetStatus),
      check: () => invoke<UpdateStatus>(IPC_CHANNELS.updatesCheck),
      installNow: () => invoke<void>(IPC_CHANNELS.updatesInstallNow),
      subscribe: (listener: (status: UpdateStatus) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
          listener(status)
        ipcRenderer.on(IPC_CHANNELS.updatesChanged, handler)
        return () => ipcRenderer.off(IPC_CHANNELS.updatesChanged, handler)
      }
    },
    /**
     * Always up, and not as a simplification.
     *
     * The other end of this carrier is the main process of the same
     * application: it cannot go away without taking this window with it, and
     * `ipcRenderer.invoke` pairs every request with its answer over a channel
     * with nothing between the two. There is no state here to report and
     * nothing that could ever change it, so the subscription is a no-op rather
     * than a listener that would never fire. `web/shell.ts` is where this
     * question has a real answer.
     */
    connection: {
      connected: () => true,
      subscribe: () => () => {}
    },
    navigation: {
      onDeepLink: (listener: (hash: string) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, hash: string): void => listener(hash)
        ipcRenderer.on(IPC_CHANNELS.navigationDeepLink, handler)
        return () => ipcRenderer.off(IPC_CHANNELS.navigationDeepLink, handler)
      }
    },
    pickAttachment: (host?: string) =>
      invoke<Attachment | null>(IPC_CHANNELS.attachmentsPick, { host }),
    // The token as stored, for a local image: this window has a custom scheme
    // registered for it - see `main/attachment-protocol.ts` - so there is
    // nothing to rewrite. A remote one gains the host as a query, which is the
    // same thing a tab does to the same token and is written once, in
    // `shared/attachments.ts`.
    attachmentSrc: (url: string, host?: string) => attachmentSrcOnHost(url, host),
    openInEditor: (input: OpenReviewFileInput) =>
      invoke<void>(IPC_CHANNELS.reviewsOpenInEditor, input)
  }
}

contextBridge.exposeInMainWorld('gitwarren', bridge)
