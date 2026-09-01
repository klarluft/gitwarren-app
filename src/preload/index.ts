/**
 * The only bridge between the renderer and the main process.
 *
 * The renderer has no Node access; it gets exactly the functions listed here
 * and nothing else. Each one unwraps the `IpcResult` envelope so that a failure
 * in the main process surfaces in React as a thrown `AppError` with its code
 * intact, which is what lets the forms show field-level messages.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { deserializeAppError } from '../shared/errors.js'
import {
  IPC_CHANNELS,
  type AppInfo,
  type GitWarrenApi,
  type IpcResult,
  type UpdateStatus
} from '../shared/api.js'
import type { RepositoryRefs, ReviewCommits, ReviewDiff } from '../shared/git.js'
import type {
  AddRepositoryInput,
  CreateReviewInput,
  GetRepositoryInput,
  GetReviewInput,
  ListReviewsInput,
  RemoveRepositoryInput,
  RemoveReviewInput,
  Repository,
  RepositoryRefsInput,
  RepositoryWithGitState,
  Review,
  ReviewCommitsInput,
  ReviewDiffInput,
  ReviewWithRepository,
  UpdateRepositoryInput,
  UpdateReviewInput
} from '../shared/schemas.js'

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  // `invoke` is typed as `any`; the envelope shape is guaranteed by `handle()`
  // in the main process, which is the only thing that answers these channels.
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>
  if (result.ok) return result.data
  throw deserializeAppError(result.error)
}

const api: GitWarrenApi = {
  repositories: {
    list: () => invoke<RepositoryWithGitState[]>(IPC_CHANNELS.repositoriesList),
    get: (input: GetRepositoryInput) =>
      invoke<RepositoryWithGitState>(IPC_CHANNELS.repositoriesGet, input),
    add: (input: AddRepositoryInput) => invoke<Repository>(IPC_CHANNELS.repositoriesAdd, input),
    update: (input: UpdateRepositoryInput) =>
      invoke<Repository>(IPC_CHANNELS.repositoriesUpdate, input),
    remove: (input: RemoveRepositoryInput) =>
      invoke<{ id: number }>(IPC_CHANNELS.repositoriesRemove, input),
    refs: (input: RepositoryRefsInput) =>
      invoke<RepositoryRefs>(IPC_CHANNELS.repositoriesRefs, input)
  },
  reviews: {
    list: (input: ListReviewsInput) => invoke<Review[]>(IPC_CHANNELS.reviewsList, input),
    get: (input: GetReviewInput) => invoke<ReviewWithRepository>(IPC_CHANNELS.reviewsGet, input),
    create: (input: CreateReviewInput) => invoke<Review>(IPC_CHANNELS.reviewsCreate, input),
    update: (input: UpdateReviewInput) => invoke<Review>(IPC_CHANNELS.reviewsUpdate, input),
    remove: (input: RemoveReviewInput) => invoke<{ id: number }>(IPC_CHANNELS.reviewsRemove, input),
    commits: (input: ReviewCommitsInput) =>
      invoke<ReviewCommits>(IPC_CHANNELS.reviewsCommits, input),
    diff: (input: ReviewDiffInput) => invoke<ReviewDiff>(IPC_CHANNELS.reviewsDiff, input)
  },
  system: {
    pickDirectory: () => invoke<string | null>(IPC_CHANNELS.systemPickDirectory),
    revealPath: (path: string) => invoke<void>(IPC_CHANNELS.systemRevealPath, path),
    appInfo: () => invoke<AppInfo>(IPC_CHANNELS.systemAppInfo)
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
  }
}

contextBridge.exposeInMainWorld('gitwarren', api)
