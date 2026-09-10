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
 * to keep the same list. What this file still does is unwrap the outcome, so a
 * failure in the main process surfaces in React as a thrown `AppError` with its
 * code intact, which is what lets the forms show field-level messages.
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
  type Carrier,
  type RpcMethod,
  type RpcOutcome,
  type RpcParams,
  type RpcResult
} from '../shared/rpc.js'
import type { Attachment, OpenReviewFileInput } from '../shared/schemas.js'

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  // `invoke` is typed as `any`; the envelope shape is guaranteed by `handle()`
  // in the main process, which is the only thing that answers these channels.
  return resultOf((await ipcRenderer.invoke(channel, payload)) as RpcOutcome<T>)
}

/**
 * Reads in flight, by method and params. An entry lives exactly as long as the
 * request it stands for - long enough to be joined, never long enough to be a
 * cache. A caller that wants a cache has SWR.
 */
const inFlight = new Map<string, Promise<unknown>>()

const carrier: Carrier = {
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    host?: string
  ): Promise<RpcResult<M>> {
    const send = (): Promise<RpcResult<M>> =>
      invoke<RpcResult<M>>(IPC_CHANNELS.rpcRequest, { method, params, host })

    if (!isReadMethod(method)) return send()

    // The host is part of the key, not a detail of it. Without it the
    // repository list of `pc-wsl` and the repository list of this Mac are the
    // same question asked twice, and the second component to ask would be
    // handed the first one's answer.
    const key = `${host ?? ''}:${method}:${JSON.stringify(params ?? null)}`
    const existing = inFlight.get(key) as Promise<RpcResult<M>> | undefined
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
    navigation: {
      onDeepLink: (listener: (hash: string) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, hash: string): void => listener(hash)
        ipcRenderer.on(IPC_CHANNELS.navigationDeepLink, handler)
        return () => ipcRenderer.off(IPC_CHANNELS.navigationDeepLink, handler)
      }
    },
    pickAttachment: () => invoke<Attachment | null>(IPC_CHANNELS.attachmentsPick),
    // The token as stored. This window has a custom scheme registered for it -
    // see `main/attachment-protocol.ts` - so there is nothing to rewrite.
    attachmentSrc: (url: string) => url,
    openInEditor: (input: OpenReviewFileInput) =>
      invoke<void>(IPC_CHANNELS.reviewsOpenInEditor, input)
  }
}

contextBridge.exposeInMainWorld('gitwarren', bridge)
