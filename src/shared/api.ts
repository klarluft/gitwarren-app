/**
 * The contract between the main process and the renderer.
 *
 * Channel names and the shape of the bridge live here so the preload script and
 * the React code are typed from one declaration. The MCP server does not use
 * any of this - it talks to `core/services` directly - which is deliberate:
 * this file is transport, not behaviour.
 */
import type { SerializedAppError } from './errors.js'
import type {
  AddRepositoryInput,
  GetRepositoryInput,
  RemoveRepositoryInput,
  Repository,
  RepositoryWithGitState,
  UpdateRepositoryInput
} from './schemas.js'

export const IPC_CHANNELS = {
  repositoriesList: 'repositories:list',
  repositoriesGet: 'repositories:get',
  repositoriesAdd: 'repositories:add',
  repositoriesUpdate: 'repositories:update',
  repositoriesRemove: 'repositories:remove',
  systemPickDirectory: 'system:pickDirectory',
  systemRevealPath: 'system:revealPath',
  systemAppInfo: 'system:appInfo',
  updatesGetStatus: 'updates:getStatus',
  updatesCheck: 'updates:check',
  updatesInstallNow: 'updates:installNow',
  /** Main -> renderer push, so the UI reflects download progress live. */
  updatesChanged: 'updates:changed'
} as const

/**
 * Errors cannot cross `ipcRenderer.invoke` intact - Electron stringifies them
 * and the code would be lost. Every handler returns this envelope instead, and
 * the preload script turns a failure back into a real `AppError` before the
 * renderer ever sees it.
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedAppError }

export interface AppInfo {
  version: string
  /** `process.platform`: 'darwin' | 'win32' | 'linux' in practice. Typed as a
   *  plain string because this module is also compiled for the renderer, which
   *  has no Node type definitions. */
  platform: string
  /** False in `electron-vite dev`, where auto-update is inert. */
  packaged: boolean
  dataDirectory: string
  databasePath: string
  /** Everything an agent needs to be pointed at this install's MCP server. */
  mcp: McpLaunchInfo
}

export interface McpLaunchInfo {
  command: string
  args: string[]
  env: Record<string, string>
  /** True once the built server file is actually present on disk. */
  available: boolean
  /**
   * False when the paths above are only valid for the current run. An AppImage
   * mounts itself at a fresh temporary directory every launch, so a config
   * copied from a running AppImage would break on the next start.
   */
  stable: boolean
  /** Shown in the UI when the configuration needs a caveat. */
  note?: string
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'unsupported'; reason: string }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number; version: string | null }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export interface GitWarrenApi {
  repositories: {
    list(): Promise<RepositoryWithGitState[]>
    get(input: GetRepositoryInput): Promise<RepositoryWithGitState>
    add(input: AddRepositoryInput): Promise<Repository>
    update(input: UpdateRepositoryInput): Promise<Repository>
    remove(input: RemoveRepositoryInput): Promise<{ id: number }>
  }
  system: {
    /** Opens the native folder picker. Resolves to null if cancelled. */
    pickDirectory(): Promise<string | null>
    revealPath(path: string): Promise<void>
    appInfo(): Promise<AppInfo>
  }
  updates: {
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    /** Quits and applies a downloaded update. */
    installNow(): Promise<void>
    /** Returns an unsubscribe function. */
    subscribe(listener: (status: UpdateStatus) => void): () => void
  }
}
