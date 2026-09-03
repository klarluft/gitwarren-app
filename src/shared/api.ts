/**
 * The contract between the main process and the renderer.
 *
 * Channel names and the shape of the bridge live here so the preload script and
 * the React code are typed from one declaration. The MCP server does not use
 * any of this - it talks to `core/services` directly - which is deliberate:
 * this file is transport, not behaviour.
 */
import type { SerializedAppError } from './errors.js'
import type { FileContent, RepositoryRefs, ReviewCommits, ReviewDiff } from './git.js'
import type {
  AddRepositoryInput,
  Attachment,
  Comment,
  CommentThread,
  CreateReviewInput,
  CreateThreadInput,
  GetRepositoryInput,
  GetReviewInput,
  ListCommentsInput,
  ListReviewsInput,
  OpenReviewFileInput,
  RemoveCommentInput,
  RemoveRepositoryInput,
  RemoveReviewInput,
  ReplyToThreadInput,
  Repository,
  RepositoryRefsInput,
  RepositoryWithGitState,
  Review,
  ReviewCommitsInput,
  ReviewDiffInput,
  ReviewFileInput,
  ReviewWithRepository,
  SetThreadResolvedInput,
  UpdateCommentInput,
  UpdateRepositoryInput,
  UpdateReviewInput
} from './schemas.js'

export const IPC_CHANNELS = {
  repositoriesList: 'repositories:list',
  repositoriesGet: 'repositories:get',
  repositoriesAdd: 'repositories:add',
  repositoriesUpdate: 'repositories:update',
  repositoriesRemove: 'repositories:remove',
  repositoriesRefs: 'repositories:refs',
  reviewsList: 'reviews:list',
  reviewsGet: 'reviews:get',
  reviewsCreate: 'reviews:create',
  reviewsUpdate: 'reviews:update',
  reviewsRemove: 'reviews:remove',
  reviewsCommits: 'reviews:commits',
  reviewsDiff: 'reviews:diff',
  reviewsFile: 'reviews:file',
  reviewsOpenInEditor: 'reviews:openInEditor',
  commentsList: 'comments:list',
  commentsCreateThread: 'comments:createThread',
  commentsReply: 'comments:reply',
  commentsUpdate: 'comments:update',
  commentsRemove: 'comments:remove',
  commentsSetResolved: 'comments:setResolved',
  systemPickDirectory: 'system:pickDirectory',
  systemRevealPath: 'system:revealPath',
  systemAppInfo: 'system:appInfo',
  systemEditors: 'system:editors',
  attachmentsIngest: 'attachments:ingest',
  attachmentsPick: 'attachments:pick',
  updatesGetStatus: 'updates:getStatus',
  updatesCheck: 'updates:check',
  updatesInstallNow: 'updates:installNow',
  /** Main -> renderer push, so the UI reflects download progress live. */
  updatesChanged: 'updates:changed',
  /**
   * Main -> renderer push carrying a hash to move to, sent when a
   * `gitwarren://` deep link arrives while the app is already running.
   */
  navigationDeepLink: 'navigation:deepLink'
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

/**
 * An image on its way into the store.
 *
 * A plain array of bytes rather than a Buffer or a Blob: the structured clone
 * used by `ipcRenderer.invoke` carries `number[]` and `ArrayBuffer` faithfully,
 * while Node's Buffer is not a thing the renderer has. The main process turns
 * it back into bytes on arrival.
 */
export interface AttachmentIngestInput {
  bytes: ArrayBuffer
  /** Only ever used for display and default alt text; the format is sniffed. */
  originalName?: string
}

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

/** One code editor GitWarren found installed. */
export interface EditorInfo {
  id: string
  label: string
}

export interface EditorList {
  editors: EditorInfo[]
  /** Used when a caller does not name one. Null when nothing was found. */
  defaultId: string | null
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
    /** Branches, tags and worktrees, for the review endpoint pickers. */
    refs(input: RepositoryRefsInput): Promise<RepositoryRefs>
  }
  reviews: {
    list(input: ListReviewsInput): Promise<Review[]>
    get(input: GetReviewInput): Promise<ReviewWithRepository>
    create(input: CreateReviewInput): Promise<Review>
    update(input: UpdateReviewInput): Promise<Review>
    remove(input: RemoveReviewInput): Promise<{ id: number }>
    /** Commits on head that base lacks, plus the head worktree's dirty state. */
    commits(input: ReviewCommitsInput): Promise<ReviewCommits>
    /** The merge-base diff, uncommitted work folded in unless asked otherwise. */
    diff(input: ReviewDiffInput): Promise<ReviewDiff>
    /**
     * One file's head-side text, whole. This is what lets the diff show the
     * lines between its hunks; `includeUncommitted` must match the diff on
     * screen so the expanded context comes from the same version of the file.
     */
    file(input: ReviewFileInput): Promise<FileContent>
    /** Open a file of this review in the reviewer's editor, at a line. */
    openInEditor(input: OpenReviewFileInput): Promise<void>
  }
  /**
   * Comments carry no author field in either direction. Anything sent over this
   * bridge is a human by construction - typing it into the app is the only way
   * to get here - and the main process stamps it as such. See `shared/actors.ts`.
   */
  comments: {
    /**
     * Threads as stored, without anchor resolution. The renderer runs
     * `resolveAnchor` itself against the diff already on screen, so a comment
     * is never placed against a diff the reader cannot see.
     */
    list(input: ListCommentsInput): Promise<CommentThread[]>
    createThread(input: CreateThreadInput): Promise<CommentThread>
    reply(input: ReplyToThreadInput): Promise<Comment>
    update(input: UpdateCommentInput): Promise<Comment>
    remove(input: RemoveCommentInput): Promise<{ id: number; threadRemoved: boolean }>
    setResolved(input: SetThreadResolvedInput): Promise<CommentThread>
  }
  /**
   * Copying an image into the app's own store.
   *
   * The renderer has no filesystem access, so a pasted or dropped image crosses
   * as raw bytes and a picked one crosses as a path chosen by the main process.
   * Both land in the same service. Ingest happens here, at paste time, rather
   * than at save time: the token is then a live URL immediately, so Preview
   * draws the real image before the comment has been submitted.
   */
  attachments: {
    ingest(input: AttachmentIngestInput): Promise<Attachment>
    /** Opens the native image picker and ingests the choice. Null if cancelled. */
    pick(): Promise<Attachment | null>
  }
  system: {
    /** Opens the native folder picker. Resolves to null if cancelled. */
    pickDirectory(): Promise<string | null>
    revealPath(path: string): Promise<void>
    appInfo(): Promise<AppInfo>
    /**
     * Code editors found on this machine, in the order the UI should offer
     * them. Empty when none was recognised - opening a file then falls back to
     * whatever the platform associates with it.
     */
    editors(): Promise<EditorList>
  }
  /**
   * Deep links arriving from the OS while the app is running.
   *
   * The hash has already been parsed to a `Route` and written back out by the
   * main process, so what arrives here is generated by this app rather than by
   * whoever wrote the link. See `main/deep-link.ts`.
   */
  navigation: {
    /** Returns an unsubscribe function. */
    onDeepLink(listener: (hash: string) => void): () => void
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
