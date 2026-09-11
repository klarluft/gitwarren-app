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
import type { AttachmentIngestParams, BridgeCarrier, ReviewOpen, RpcMethod } from './rpc.js'
import type {
  AddHostInput,
  AddRepositoryInput,
  Attachment,
  DirectoryListing,
  ListDirectoryInput,
  GetHostInput,
  HostWithState,
  InstallOnHostInput,
  InstallReport,
  WslDistro,
  DiscoveredPeer,
  RemoveHostInput,
  SetTailnetExposureInput,
  TailnetExposure,
  UpdateHostInput,
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
  navigationDeepLink: 'navigation:deepLink',
  /**
   * Main -> renderer push carrying an `RpcEvent`: something changed, go and
   * re-read it.
   *
   * The window's half of what a browser tab gets as a frame on its socket. It
   * is a *carrier* channel rather than a shell one - see `BridgeCarrier.onEvent`
   * - which is why it is here next to `rpcRequest` rather than beside the two
   * pushes above, both of which are about this shell (an update downloading, a
   * link the OS handed us) rather than about the core's data.
   */
  rpcEvent: 'rpc:event'
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
  IPC_CHANNELS.navigationDeepLink,
  IPC_CHANNELS.rpcEvent
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
  /**
   * What this shell can do, so a screen can leave a control out rather than
   * offer one that only explains itself when pressed. See `ShellCapabilities`.
   */
  capabilities: ShellCapabilities
  /**
   * The other machines this install knows about.
   *
   * Every one of these is answered by whoever the carrier reaches and is never
   * forwarded onward - see the note on `hosts.*` in `shared/rpc.ts`. Which is
   * why the Hosts screen in a browser tab manages the *daemon's* hosts and the
   * one in the window manages the app's, without either screen knowing.
   */
  hosts: {
    list(): Promise<HostWithState[]>
    get(input: GetHostInput): Promise<HostWithState>
    add(input: AddHostInput): Promise<HostWithState>
    update(input: UpdateHostInput): Promise<HostWithState>
    remove(input: RemoveHostInput): Promise<{ id: number }>
    /** Reach it now, ignoring backoff. Never throws for an unreachable host. */
    probe(input: GetHostInput): Promise<HostWithState>
    /** Slow, and the only method here that changes the other machine. */
    install(input: InstallOnHostInput): Promise<InstallReport>
    /**
     * The WSL distributions on the machine answering, or empty everywhere else.
     *
     * Here rather than in `system` even though it looks like a fact about a
     * machine, and that is the M5 decision: the machine it is a fact *about* is
     * the one that will spawn `wsl.exe`, which is whoever answers this api - so
     * a browser tab served by a Windows install gets that install's
     * distributions, which is exactly what its Add dialog needs. See the note
     * on `hosts.distros` in `shared/rpc.ts`.
     */
    distros(): Promise<WslDistro[]>
    /**
     * Whether the machine answering is reachable on its tailnet, and where.
     *
     * Here for the same reason `distros` is, and it survives the harder version
     * of the same test. Turning exposure on is genuinely an *act* on a machine,
     * which is the thing `shared/rpc.ts` says must never travel - and it does
     * not: `isLocalOnly` refuses the whole `hosts.` prefix, so what this acts on
     * is always the machine whose core is answering. A browser tab gets its own
     * server's switch, which is exactly what a person running `gitwarren serve`
     * on a headless box needs; a GUI looking at a remote host cannot reach
     * across and start `tailscale serve` there.
     */
    /** Machines on this tailnet running GitWarren. Proposals, never rows. */
    discover(): Promise<DiscoveredPeer[]>
    tailnet(): Promise<TailnetExposure>
    setTailnetExposure(input: SetTailnetExposureInput): Promise<TailnetExposure>
  }
  /**
   * What is inside a folder, on the machine this api is pointed at.
   *
   * Not part of `system` even though the shell's own picker is, and the
   * difference is the whole of M4.3's answer to the missing picker: opening a
   * window is something only the machine with a screen can do, while reading a
   * directory is something the machine holding the directory does. On a remote
   * host those are two different computers.
   */
  fs: {
    list(input: ListDirectoryInput): Promise<DirectoryListing>
  }
  /**
   * Facts about the install this api is pointed at.
   *
   * `system.appInfo` is the shell's answer about the install *behind this
   * window or tab*, and stays that. This one is about whichever machine the
   * screen is showing, which is what the Agent Access page needs when it is
   * showing a host: the command to paste is `~/.gitwarren/bin/gitwarren-mcp`
   * *over there*, and only that machine knows what `~` is.
   *
   * A fact and not a capability, which is the line `shared/web.ts` draws and
   * the reason this may travel at all: it says where a launcher is, it does not
   * start one.
   */
  app: {
    mcp(): Promise<McpLaunchInfo>
  }
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
    /** Opens an image picker and ingests the choice. Null if cancelled. */
    pick(): Promise<Attachment | null>
    /** The token in a body, as a `src` this shell can draw. See `ShellApi`. */
    src(url: string): string
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
  /** Whether this window or tab can still reach its own core. See `ShellConnection`. */
  connection: ShellConnection
}

/**
 * Whether this shell can still reach the core it was handed.
 *
 * Not the same question as whether a *host* is answering, and M4.5 kept the two
 * apart deliberately. A host that has gone away is learned from requests that
 * fail (`renderer/lib/host-reachability.ts`); this one cannot be, because a
 * browser tab whose socket has dropped does not fail its requests at all -
 * `web/carrier.ts` queues them until it reconnects, so nothing settles and
 * there is no outcome to read. Only the socket knows.
 *
 * They also have different blast radii, which is why they are two banners and
 * not one component with a branch in it. A machine that is asleep makes *that*
 * machine's screens stale; a socket that has dropped makes every screen stale,
 * this computer's included, and while it is down nothing can be claimed about
 * any host - so its sentence is the one that wins.
 *
 * Constant `true` in the Electron window, where the other end of the carrier is
 * a process that cannot go away without taking this one with it.
 */
export interface ShellConnection {
  connected(): boolean
  /** Returns an unsubscribe function. */
  subscribe(listener: (connected: boolean) => void): () => void
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
  /**
   * Every core method, in one function, answering with an outcome rather than
   * throwing - see `BridgeCarrier` in `shared/rpc.ts` for why that distinction
   * is load-bearing across `contextBridge`. `lib/api.ts` unwraps it.
   */
  carrier: BridgeCarrier
  shell: ShellApi
}

/**
 * What this shell can do, answered before anyone tries.
 *
 * Every method on `ShellApi` exists in every shell - that is what keeps
 * `lib/api.ts` and the screens above it shell-agnostic. But some of them can
 * only refuse in a browser tab, and a control that explains itself when pressed
 * is a worse answer than a control that was never offered: the user reads a
 * button as a promise. So a screen asks here *before* rendering, and the
 * refusals stay as the backstop for a caller that did not ask.
 *
 * Deliberately a plain object rather than a promise. It is read during render,
 * it cannot change while the page is open, and a capability that arrived a tick
 * late would show every one of these controls for one frame.
 *
 * Deliberately capabilities and not a shell *name*. `if (shell === 'web')`
 * spreads a list of what each shell happens to lack to every screen that asks;
 * a flag per capability says what is actually being decided, and M4's remote
 * hosts will answer some of these differently again without a screen changing.
 */
export interface ShellCapabilities {
  /**
   * A native folder picker for adding a repository. Without one the path field
   * beside it is the whole of the interaction - which is also what a remote
   * host in M4 will need, since a picker there would browse the wrong machine.
   */
  pickDirectory: boolean
  /** Showing a path in Finder, Explorer or the desktop's file manager. */
  revealPath: boolean
  /**
   * Whether GitWarren can be made to start with the machine from in here. False
   * in a tab: the answer to "does this start at login" is a true and useful no,
   * and turning it on is `gitwarren service install` at a terminal.
   */
  openAtLogin: boolean
}

/**
 * The Electron-only surface.
 *
 * Each of these does something to *this* machine: puts a window in front of the
 * user, launches a program, quits and reinstalls the app. None of them is a
 * method on the dispatcher, and none of them may become one - a request that
 * could start a process on a host across the network would make this a very
 * different piece of software. See the note in `core/rpc/dispatcher.ts`.
 *
 * "Electron-only" is the origin of this interface rather than a description of
 * it any more: since M3 a browser tab supplies one too, doing what a tab can do
 * and saying so through `capabilities`.
 */
export interface ShellApi {
  capabilities: ShellCapabilities
  system: GitWarrenApi['system']
  updates: GitWarrenApi['updates']
  navigation: GitWarrenApi['navigation']
  /**
   * Whether the carrier underneath this shell is up.
   *
   * On this side of the line because it is a fact about the transport this
   * shell built, and the transports differ: the preload has an IPC channel to
   * its own main process, a tab has a socket that can drop. Not on the
   * dispatcher for the obvious reason - asking a machine whether it can be
   * reached only works when it can.
   */
  connection: ShellConnection
  /**
   * A picker, then straight into `attachments.ingest`.
   *
   * `host` is where the image has to end up - the machine that owns the review
   * being commented on - and absent means this one. The picker itself is always
   * this machine's, because the file being attached is a file the person can
   * see; what travels is the bytes, which is the one shape that works for a
   * screenshot with no path at all.
   */
  pickAttachment(host?: string): Promise<Attachment | null>
  /**
   * The `src` this shell can actually draw an attachment token from.
   *
   * A comment body holds `gitwarren://attachment/<sha>.<ext>` whoever reads it,
   * because the body is stored text and must not depend on which shell renders
   * it. Turning that into something fetchable is the shell's job and happens at
   * the `<img>` and nowhere else: the window passes it through to its custom
   * scheme, and a tab rewrites it to a path on its own origin.
   *
   * `host` is the instance id of the machine whose store holds the file, and
   * absent means this one. It is not in the token for the same reason a review
   * id is not: the body is text on one machine and has no business naming
   * another. Both shells attach it as a query, and the local case is therefore
   * the token unchanged - see `ATTACHMENT_HOST_PARAM`.
   *
   * Synchronous, and it has to be: it is called during render, once per image.
   */
  attachmentSrc(url: string, host?: string): string
  /**
   * Ask the owning host where the file is, then open it here.
   *
   * Two halves that must not be merged: *which* file on disk is review
   * knowledge and belongs to whoever owns the review, while launching an
   * application is a capability of the machine the person is sitting at.
   *
   * `input.host` says which machine the path is on, and it travels with the
   * path rather than binding the shell to a host: this shell is the one the
   * person is sitting at whatever the screen is showing, and what it needs to
   * know is which filesystem the file it is about to open lives on.
   */
  openInEditor(input: OpenReviewFileInput): Promise<void>
}
