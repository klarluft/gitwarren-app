/**
 * The contract between the Electron shell and the renderer.
 *
 * Two things live here, and the line between them is the one M1 drew.
 *
 * `GitWarrenApi` is what a screen sees: the whole app, grouped by object. Most
 * of it is now one carrier call each (`shared/rpc.ts`), and `lib/api.ts` builds
 * it. What is left in this file that is *not* a carrier call is the Electron
 * shell - folder pickers, revealing a path, launching an editor, the updater,
 * deep links. Those are capabilities of the machine the person is sitting at.
 * They are not methods, they never travel to another host, and a browser tab in
 * M3 will simply not have some of them.
 *
 * `GitWarrenBridge` is what the preload actually exposes: the carrier plus that
 * shell surface, and nothing else.
 *
 * The MCP server uses none of this - it talks to `core/services` directly - and
 * that is deliberate: this file is transport, not behaviour.
 */
import type { FileContent, FileImage, RepositoryRefs, ReviewCommits, ReviewDiff } from './git.js'
import type { AttachmentIngestParams, Carrier, ReviewOpen, RpcMethod } from './rpc.js'
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
  ReviewedFile,
  ReviewFileInput,
  ReviewImageInput,
  ReviewWithRepository,
  ListReviewedFilesInput,
  SetFileReviewedInput,
  SetThreadResolvedInput,
  UpdateCommentInput,
  UpdateRepositoryInput,
  UpdateReviewInput
} from './schemas.js'

export const IPC_CHANNELS = {
  /**
   * The carrier. One channel, every core method, `{method, params}` in and an
   * `RpcOutcome` out - see `shared/rpc.ts`.
   *
   * The per-object channels below still answer, each a one-line delegation to
   * the same dispatcher, so nothing that spoke to this app before M1 has
   * stopped being spoken to. The renderer no longer uses them.
   */
  rpcRequest: 'rpc:request',
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
  reviewsImage: 'reviews:image',
  reviewsOpenInEditor: 'reviews:openInEditor',
  reviewsReviewedFiles: 'reviews:reviewedFiles',
  reviewsSetFileReviewed: 'reviews:setFileReviewed',
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
  /**
   * Whether GitWarren starts with the machine. Two channels rather than a
   * field on `appInfo`, because it is the one piece of app state the user can
   * change from outside the app - through System Settings, or by deleting a
   * `.desktop` file - so it is read on demand and never cached alongside
   * things that cannot change.
   */
  systemGetOpenAtLogin: 'system:getOpenAtLogin',
  systemSetOpenAtLogin: 'system:setOpenAtLogin',
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
 * The channels that are one method by another name.
 *
 * Every one of these existed before M1 and still answers; each is now a
 * one-line delegation to the dispatcher. They are a table rather than a list of
 * registration calls so that `main/ipc.ts` and the test that checks none of
 * them was dropped read the same thing.
 *
 * The renderer does not use them - it goes through `rpcRequest` - but a channel
 * is a published surface, and removing one would be a change with no way to
 * find out who noticed.
 */
export const CHANNEL_METHODS = {
  [IPC_CHANNELS.repositoriesList]: 'repositories.list',
  [IPC_CHANNELS.repositoriesGet]: 'repositories.get',
  [IPC_CHANNELS.repositoriesAdd]: 'repositories.add',
  [IPC_CHANNELS.repositoriesUpdate]: 'repositories.update',
  [IPC_CHANNELS.repositoriesRemove]: 'repositories.remove',
  [IPC_CHANNELS.repositoriesRefs]: 'repositories.refs',
  [IPC_CHANNELS.reviewsList]: 'reviews.list',
  [IPC_CHANNELS.reviewsGet]: 'reviews.get',
  [IPC_CHANNELS.reviewsCreate]: 'reviews.create',
  [IPC_CHANNELS.reviewsUpdate]: 'reviews.update',
  [IPC_CHANNELS.reviewsRemove]: 'reviews.remove',
  [IPC_CHANNELS.reviewsCommits]: 'reviews.commits',
  [IPC_CHANNELS.reviewsDiff]: 'reviews.diff',
  [IPC_CHANNELS.reviewsFile]: 'reviews.file',
  [IPC_CHANNELS.reviewsImage]: 'reviews.image',
  [IPC_CHANNELS.reviewsReviewedFiles]: 'reviews.reviewedFiles',
  [IPC_CHANNELS.reviewsSetFileReviewed]: 'reviews.setFileReviewed',
  [IPC_CHANNELS.commentsList]: 'comments.list',
  [IPC_CHANNELS.commentsCreateThread]: 'comments.createThread',
  [IPC_CHANNELS.commentsReply]: 'comments.reply',
  [IPC_CHANNELS.commentsUpdate]: 'comments.update',
  [IPC_CHANNELS.commentsRemove]: 'comments.remove',
  [IPC_CHANNELS.commentsSetResolved]: 'comments.setResolved',
  [IPC_CHANNELS.attachmentsIngest]: 'attachments.ingest'
} as const satisfies Record<string, RpcMethod>

/**
 * The channels the shell answers itself, because each one does something to
 * this machine: puts a window in front of the person, launches a program, quits
 * and reinstalls the app. None of them is a method, and none may become one.
 */
export const SHELL_CHANNELS = [
  IPC_CHANNELS.reviewsOpenInEditor,
  IPC_CHANNELS.attachmentsPick,
  IPC_CHANNELS.systemPickDirectory,
  IPC_CHANNELS.systemRevealPath,
  IPC_CHANNELS.systemEditors,
  IPC_CHANNELS.systemAppInfo,
  IPC_CHANNELS.systemGetOpenAtLogin,
  IPC_CHANNELS.systemSetOpenAtLogin,
  IPC_CHANNELS.updatesGetStatus,
  IPC_CHANNELS.updatesCheck,
  IPC_CHANNELS.updatesInstallNow
] as const

/** Main -> renderer pushes. Nothing handles these; they are sent. */
export const PUSH_CHANNELS = [
  IPC_CHANNELS.updatesChanged,
  IPC_CHANNELS.navigationDeepLink
] as const

export interface AppInfo {
  version: string
  /**
   * This install's id - see `core/instance.ts`. Stable for the life of the data
   * directory, and how a host, a link or a principal names this GitWarren once
   * there is more than one of them to tell apart.
   */
  instanceId: string
  /** `process.platform`: 'darwin' | 'win32' | 'linux' in practice. Typed as a
   *  plain string because this module is also compiled for the renderer, which
   *  has no Node type definitions. */
  platform: string
  /** False in `electron-vite dev`, where auto-update is inert. */
  packaged: boolean
  dataDirectory: string
  databasePath: string
  /**
   * The loopback port this install is serving links on, or null when something
   * else holds it.
   *
   * Null does not mean links are broken everywhere - they are minted against
   * the fixed port whoever reads them, because a link is read on other machines
   * and on other days. It means links into *this* app will not open until
   * whatever took the port lets go, which is worth saying out loud rather than
   * leaving the user to discover in a browser.
   */
  linkPort: number | null
  /** Everything an agent needs to be pointed at this install's MCP server. */
  mcp: McpLaunchInfo
}

/**
 * How an agent starts this install's MCP server.
 *
 * Since M2 `command` is the stable launcher - `~/.gitwarren/bin/gitwarren-mcp`,
 * a `.cmd` on Windows - which the app maintains and which therefore survives an
 * update, a move, and the AppImage remounting itself. `args` and `env` are
 * empty by design: the whole value of the launcher is that the instruction fits
 * in a sentence, and a sentence with an environment variable in it does not.
 */
export interface McpLaunchInfo {
  command: string
  args: string[]
  env: Record<string, string>
  /** True once the built server file is actually present on disk. */
  available: boolean
  /**
   * False when the command above is only valid for the current run.
   *
   * Always true since M2, because the launcher is what the command names. Kept
   * because M4 reintroduces the case from the other end: a remote host whose
   * daemon has not been installed yet has no launcher to name.
   */
  stable: boolean
  /**
   * The binary and script the launcher wraps.
   *
   * Shown behind "configure by hand", and the fallback when the launcher could
   * not be written. It is what every agent config held before M2, so a user who
   * has one already can see that nothing about it has changed.
   */
  direct: { command: string; args: string[]; env: Record<string, string> }
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
    /**
     * Everything the review screen needs, in one call: the review, its threads
     * and its reviewed marks. What the screens actually use - `get`, `list` and
     * `reviewedFiles` remain for callers that want one of the three on its own.
     */
    open(input: GetReviewInput): Promise<ReviewOpen>
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
     * lines between its hunks; `changes` must match the diff on screen so the
     * expanded context comes from the same version of the file.
     */
    file(input: ReviewFileInput): Promise<FileContent>
    /**
     * One side's bytes of an image in this review, as a `data:` URL. Asked for
     * a side at a time, because a change to a picture is two pictures.
     */
    image(input: ReviewImageInput): Promise<FileImage>
    /** Open a file of this review in the reviewer's editor, at a line. */
    openInEditor(input: OpenReviewFileInput): Promise<void>
    /**
     * Files the reviewer has ticked off, each with the fingerprint of the diff
     * they read. Whether a mark still applies is decided in the renderer,
     * against the diff on screen - see `shared/diff-digest.ts`.
     */
    reviewedFiles(input: ListReviewedFilesInput): Promise<ReviewedFile[]>
    /** Tick a file off against a digest, or clear the tick with a null one. */
    setFileReviewed(input: SetFileReviewedInput): Promise<ReviewedFile | null>
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
    ingest(input: AttachmentIngestParams): Promise<Attachment>
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
    /** Whether GitWarren starts with the machine. Read from the OS each time. */
    getOpenAtLogin(): Promise<boolean>
    /**
     * Turn it on or off. Resolves to what the OS says afterwards rather than to
     * what was asked for, so a write that silently failed shows as unchanged
     * instead of as a toggle that springs back on the next read.
     */
    setOpenAtLogin(openAtLogin: boolean): Promise<boolean>
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

/**
 * What the preload script exposes on `window`.
 *
 * The carrier, and the handful of things only this shell can do. Deliberately
 * not `GitWarrenApi`: that one is assembled in the renderer, on top of this, so
 * that the day a browser tab supplies a WebSocket carrier instead, the screens
 * above it do not change at all.
 */
export interface GitWarrenBridge {
  /** Every core method, in one function. See `shared/rpc.ts`. */
  carrier: Carrier
  shell: ShellApi
}

/**
 * The Electron-only surface.
 *
 * Each of these does something to *this* machine: puts a window in front of the
 * user, launches a program, quits and reinstalls the app. None of them is a
 * method on the dispatcher, and none of them may become one - a request that
 * could start a process on a host across the network would make this a very
 * different piece of software. See the note in `core/rpc/dispatcher.ts`.
 */
export interface ShellApi {
  system: GitWarrenApi['system']
  updates: GitWarrenApi['updates']
  navigation: GitWarrenApi['navigation']
  /** Native picker, then straight into `attachments.ingest`. */
  pickAttachment(): Promise<Attachment | null>
  /**
   * Ask the owning host where the file is, then open it here.
   *
   * Two halves that must not be merged: *which* file on disk is review
   * knowledge and belongs to whoever owns the review, while launching an
   * application is a capability of the machine the person is sitting at.
   */
  openInEditor(input: OpenReviewFileInput): Promise<void>
}
