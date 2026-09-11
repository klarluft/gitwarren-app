/**
 * The message protocol: requests, responses and events.
 *
 * One protocol, several carriers. Today the only carrier is Electron IPC and
 * everything runs in one process, so this file can look like ceremony around a
 * function call. It is not: the same three message shapes have to survive a
 * child-process pipe, `wsl.exe`, `ssh` and a WebSocket without changing, and
 * the way to make sure of that is to write them down once, here, where the
 * renderer, the main process, the daemon and the tests all read them from. See
 * docs/across-hosts.md.
 *
 * Plain types and two small functions - no Node, no Electron, no zod. The
 * renderer imports this module too, and a carrier is allowed to be nothing more
 * than "put this object in, get that object out".
 *
 * Validation is deliberately absent. Every method's params are re-parsed by the
 * service that answers it, with the zod schema in `schemas.ts`, which is the
 * check that matters; a second one here would be a second place to keep in step
 * and a second opinion about what a valid review is.
 */
import { AppError, deserializeAppError, type SerializedAppError } from './errors.js'
import type { McpLaunchInfo } from './api.js'
import type { FileContent, FileImage, RepositoryRefs, ReviewCommits, ReviewDiff } from './git.js'
import type {
  AddHostInput,
  AddRepositoryInput,
  Attachment,
  AttachmentBytes,
  GetHostInput,
  HostWithState,
  InstallOnHostInput,
  InstallReport,
  RemoveHostInput,
  UpdateHostInput,
  Comment,
  CommentThread,
  CreateReviewInput,
  CreateThreadInput,
  DirectoryListing,
  GetRepositoryInput,
  GetReviewInput,
  ListCommentsInput,
  ListDirectoryInput,
  ListReviewedFilesInput,
  ListReviewsInput,
  RemoveCommentInput,
  RemoveRepositoryInput,
  RemoveReviewInput,
  ReadAttachmentInput,
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
  SetFileReviewedInput,
  SetThreadResolvedInput,
  UpdateCommentInput,
  UpdateRepositoryInput,
  UpdateReviewInput
} from './schemas.js'

/**
 * Bumped when a change would make an older peer misread a message.
 *
 * Adding a method or a field is not such a change: an unknown method comes back
 * as an error the caller can read, and unknown fields are ignored. The constant
 * is here now so that M4's handshake has something to exchange, rather than
 * having to invent one under time pressure.
 */
export const RPC_PROTOCOL_VERSION = 1

/**
 * Who just answered.
 *
 * `instanceId` is the durable identity of the install (`core/instance.ts`) and
 * is what `hosts.instance_id` and `repositories.host_id` store. `protocol` is
 * `RPC_PROTOCOL_VERSION` as the *responder* understands it, which is the point
 * of exchanging it at all: the two ends of an `ssh` pipe are separately
 * installed and separately updated, and there is no package manager keeping
 * them in step.
 *
 * `version` is the human-readable release, for a Hosts screen to show and for a
 * person to compare against their own. Nothing branches on it - a decision made
 * from a marketing version rather than from a protocol number is a decision
 * that breaks on a hotfix.
 */
export interface HostIdentity {
  instanceId: string
  protocol: number
  version: string
}

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  /** Unique per connection. Answers may come back in any order. */
  id: number
  method: M
  params?: RpcParams<M>
  /**
   * Which install this is for: an instance id, or absent for whoever receives
   * it.
   *
   * On the envelope rather than in `params`, because where a request goes is
   * not part of what the method means - `reviews.diff` has one meaning and it
   * is the same on every machine. It is also the field the router *removes*
   * before forwarding, which is what stops a chain of hosts forming: what
   * arrives at the far end has no host on it, so the far end answers it itself.
   * See `core/hosts/router.ts`.
   */
  host?: string
}

/**
 * How a call turned out: exactly one of `result` and `error`.
 *
 * `SerializedAppError` rather than a protocol error type of its own. The code
 * vocabulary in `errors.ts` is already what every surface speaks, field errors
 * included, and a second one here would mean translating between them at every
 * carrier. A failed request carries exactly what a thrown `AppError` carried
 * before there was a wire to put it on.
 *
 * Separate from `RpcResponse` because not every carrier needs the id. Electron's
 * `invoke` pairs a call with its answer itself, so the IPC carrier sends an
 * outcome and nothing else; a byte stream has to say which request it is
 * answering, and adds one.
 */
export type RpcOutcome<T = unknown> = { result: T } | { error: SerializedAppError }

export type RpcResponse<T = unknown> = RpcOutcome<T> & { id: number }

/**
 * A push from whoever owns the data. Carries no id: nobody asked for it.
 *
 * Nothing emits one yet - the renderer polls, and M6 is where events replace
 * that - but the shape belongs next to the other two, because a carrier reading
 * a stream has to be able to tell an event from an answer.
 */
export interface RpcEvent<T = unknown> {
  event: string
  data: T
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent

/** Discriminators, for a carrier reading a stream of mixed messages. */
export function isRpcEvent(message: RpcMessage): message is RpcEvent {
  return 'event' in message
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return 'id' in message && !('method' in message)
}

/**
 * Everything the core can be asked to do, and nothing else.
 *
 * What is *not* here is as deliberate as what is. Opening a folder picker,
 * revealing a path, launching an editor, checking for an update: those are
 * things a shell does on the machine the person is sitting at, and none of them
 * may ever become something a remote host is asked to perform. They stay
 * outside this map - see `GitWarrenApi` in `api.ts` for where they live.
 *
 * Object-centric on purpose. Every method names a review or a repository by id,
 * never a raw ref, and a path only ever means "a file of this review". Whoever
 * answers resolves refs itself, so a caller on another machine cannot ask for a
 * diff between two arbitrary strings.
 */
export interface RpcMethods {
  /**
   * Who is answering, and what they speak. The handshake `RPC_PROTOCOL_VERSION`
   * was reserved for.
   *
   * Asked by a GUI on the first successful connection to a host, so the host's
   * own instance id can be written into the `hosts` row - see
   * `core/services/hosts.ts`. It is the only method whose answer is about the
   * responder rather than about a repository, which is exactly why it has to be
   * a method: nothing else on the wire can say *which machine* just replied.
   *
   * Cheap and side-effect-free on purpose. It is also the natural thing for a
   * future health check to call, and a health check that wrote something would
   * be a health check nobody could run twice.
   */
  'app.instance': { params: void; result: HostIdentity }

  /**
   * How an agent starts *this* install's MCP server.
   *
   * A fact about the machine, which is the line that decides whether something
   * may travel at all - see the note on `appInfo` in `shared/web.ts`. It says
   * where a launcher is; it does not start one, and nothing here opens a window
   * or reads a clipboard.
   *
   * It exists because the Agent Access page is per host: `#/h/<id>/agent` has to
   * print `~/.gitwarren/bin/gitwarren-mcp` as that machine resolves it, since a
   * Mac has no way to know what `~` is on `pc-wsl`. `gitwarren agent-setup` on
   * the host prints the same command from the same function, which is what
   * `shared/agent-setup.ts` exists to guarantee.
   */
  'app.mcp': { params: void; result: McpLaunchInfo }

  /**
   * Managing the list of *other* machines this install knows about.
   *
   * In the map because both shells need them - the Hosts screen exists in a
   * browser tab as much as in the window, and M3 settled that a screen reaches
   * the core through the dispatcher and nowhere else.
   *
   * Answered by the install the person is driving, and never forwarded to a
   * host. A host's list of hosts is its own business, and routing these onward
   * would turn a hub and its spokes into a mesh, where removing a machine from
   * one list could remove it from another. `isLocalOnly` in `core/hosts/ssh.ts`
   * is the backstop that makes that structural, and `core/hosts/router.ts` is
   * where the general local-versus-remote decision lives: it answers these here
   * before it ever looks at the host on the envelope.
   */
  'hosts.list': { params: void; result: HostWithState[] }
  'hosts.get': { params: GetHostInput; result: HostWithState }
  'hosts.add': { params: AddHostInput; result: HostWithState }
  'hosts.update': { params: UpdateHostInput; result: HostWithState }
  'hosts.remove': { params: RemoveHostInput; result: { id: number } }
  /** Reach a host now, ignoring backoff. Answers with what happened. */
  'hosts.probe': { params: GetHostInput; result: HostWithState }
  /**
   * Put the daemon on a host, or say that it is already there.
   *
   * The slowest method in this interface by a wide margin - a download and a
   * 45 MB stream - and the only one with no timeout on either side, which is
   * deliberate: there is no number of seconds after which abandoning a
   * part-finished install would be an improvement. See `core/hosts/install.ts`
   * on why it reports nothing until it is done.
   */
  'hosts.install': { params: InstallOnHostInput; result: InstallReport }

  /**
   * What is inside a folder, on the machine that answers.
   *
   * The one method here that exists because of a *capability* rather than a
   * domain, and the reason it is a method at all is M4.3. Opening a folder
   * picker is a thing the shell does on the machine the person is sitting at -
   * so it stays out of this map, per the note above - but on a remote host that
   * picker would browse the wrong filesystem, and in a browser tab there is no
   * picker to open. Splitting the gesture in two puts the window where the
   * screen is and the directory where the files are.
   *
   * Reads nothing but names, and never a file's contents: see
   * `core/services/fs.ts` on why there is no sandbox and what the real
   * boundary is.
   */
  'fs.list': { params: ListDirectoryInput; result: DirectoryListing }

  'repositories.list': { params: void; result: RepositoryWithGitState[] }
  'repositories.get': { params: GetRepositoryInput; result: RepositoryWithGitState }
  'repositories.add': { params: AddRepositoryInput; result: Repository }
  'repositories.update': { params: UpdateRepositoryInput; result: Repository }
  'repositories.remove': { params: RemoveRepositoryInput; result: { id: number } }
  'repositories.refs': { params: RepositoryRefsInput; result: RepositoryRefs }

  'reviews.list': { params: ListReviewsInput; result: Review[] }
  /** The coarse one. See `ReviewOpen`. */
  'reviews.open': { params: GetReviewInput; result: ReviewOpen }
  'reviews.get': { params: GetReviewInput; result: ReviewWithRepository }
  'reviews.create': { params: CreateReviewInput; result: Review }
  'reviews.update': { params: UpdateReviewInput; result: Review }
  'reviews.remove': { params: RemoveReviewInput; result: { id: number } }
  'reviews.commits': { params: ReviewCommitsInput; result: ReviewCommits }
  'reviews.diff': { params: ReviewDiffInput; result: ReviewDiff }
  'reviews.file': { params: ReviewFileInput; result: FileContent }
  'reviews.image': { params: ReviewImageInput; result: FileImage }
  /**
   * Where a file of this review is on disk, on the host that owns it.
   *
   * A method rather than a main-process detail, because of who will have to
   * ask. Launching an editor is the shell's job, but only the owning host knows
   * whether the head branch is checked out somewhere other than the repository
   * path - so the shell asks, and then launches.
   */
  'reviews.filePath': { params: ReviewFileInput; result: string }
  'reviews.reviewedFiles': { params: ListReviewedFilesInput; result: ReviewedFile[] }
  'reviews.setFileReviewed': { params: SetFileReviewedInput; result: ReviewedFile | null }

  'comments.list': { params: ListCommentsInput; result: CommentThread[] }
  'comments.createThread': { params: CreateThreadInput; result: CommentThread }
  'comments.reply': { params: ReplyToThreadInput; result: Comment }
  'comments.update': { params: UpdateCommentInput; result: Comment }
  'comments.remove': { params: RemoveCommentInput; result: { id: number; threadRemoved: boolean } }
  'comments.setResolved': { params: SetThreadResolvedInput; result: CommentThread }

  'attachments.ingest': { params: AttachmentIngestParams; result: Attachment }
  /**
   * The bytes behind a token, from the store that holds them.
   *
   * A method rather than a file read because of who has to ask. An image lives
   * in the store of the machine that owns the review, and both shells serve it
   * off their own disk - so until M4.4 an image on a remote review was a broken
   * one, resolved against a store that has never heard of that sha. Making it a
   * method puts the question through the router, and `(host, name)` is then
   * answered by the machine the name means something on.
   */
  'attachments.read': { params: ReadAttachmentInput; result: AttachmentBytes }
}

export type RpcMethod = keyof RpcMethods
export type RpcParams<M extends RpcMethod> = RpcMethods[M]['params']
export type RpcResult<M extends RpcMethod> = RpcMethods[M]['result']

/**
 * Everything needed to put a review on screen, in one answer.
 *
 * Three reads that used to be three round trips: the review with its
 * repository, the discussion, and which files have been ticked off. All three
 * are indexed SQLite queries, all three are wanted the instant a review is
 * opened, and not one of them is useful without the others - so over a network
 * they were three waits for no benefit. See spike S5 in docs/across-hosts.md.
 *
 * The diff and the commit list stay separate. They are the expensive half, they
 * are refreshed on their own schedule, and they already run in parallel with
 * this one.
 */
export interface ReviewOpen {
  review: ReviewWithRepository
  /** Threads as stored, unanchored - see `comments.list`. */
  threads: CommentThread[]
  reviewedFiles: ReviewedFile[]
}

/**
 * An image on its way into the store.
 *
 * Bytes rather than a path: the renderer has no filesystem, so a pasted or
 * dropped image has to travel. This is the one method whose params are not the
 * same on every carrier, and M2 is where that became visible - it is the only
 * change the protocol needed in order to survive a byte stream.
 *
 * `ArrayBuffer` survives Electron's structured clone and is what the renderer
 * sends. It does *not* survive `JSON.stringify`, which turns it into `{}` - so
 * a carrier over a pipe, a socket or `ssh` cannot use that form at all, and
 * would previously have produced an `INTERNAL` error from a `Buffer.from({})`
 * deep inside the dispatcher rather than anything a caller could read.
 *
 * `string` is base64 and is the form a JSON carrier should send: about 1.33
 * bytes on the wire per byte of image. `number[]` also works and is what a
 * naive `JSON.stringify` of a byte array produces, but it costs about four
 * bytes per byte and exists for compatibility rather than as a recommendation.
 *
 * `ArrayBufferView` - a `Uint8Array` and its relatives - is the shape an
 * `ArrayBuffer` comes out of structured clone as, and is taken over its own
 * byte range rather than over the buffer behind it.
 *
 * Whoever answers accepts all four; see `toIngestSource` in
 * `core/rpc/dispatcher.ts`, which is the one place that decides.
 */
export interface AttachmentIngestParams {
  bytes: ArrayBuffer | ArrayBufferView | number[] | string
  /** Only ever used for display and default alt text; the format is sniffed. */
  originalName?: string
}

/**
 * The methods that only read.
 *
 * Two identical reads in flight at once are the same read, so a carrier may
 * answer both from one round trip. Two identical writes are two writes and must
 * never be folded into one - which is why this is a list someone maintains
 * rather than a guess made from the method name.
 */
export const READ_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'app.instance',
  'app.mcp',
  'hosts.list',
  'hosts.get',
  // `hosts.probe` is deliberately absent. It reads in the sense that it changes
  // no host row a caller can see, but it opens a connection and clears a
  // backoff, and two people pressing "try now" at the same moment should mean
  // two attempts - which is the whole reason the button exists.
  'fs.list',
  'repositories.list',
  'repositories.get',
  'repositories.refs',
  'reviews.list',
  'reviews.open',
  'reviews.get',
  'reviews.commits',
  'reviews.diff',
  'reviews.file',
  'reviews.image',
  'reviews.filePath',
  'reviews.reviewedFiles',
  'comments.list',
  // Two `<img>` elements on one screen naming the same token is ordinary - a
  // screenshot quoted in a reply, the same picture in a description and a
  // comment - and the answer is a few hundred kilobytes over a pipe. This is
  // the entry in this list that most earns its place.
  'attachments.read'
])

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method as RpcMethod)
}

/**
 * A way to reach whoever answers. The whole point of the exercise.
 *
 * One function. Everything M2 through M5 adds - a child-process pipe, a
 * WebSocket, `wsl.exe`, `ssh` - is another implementation of this interface,
 * and nothing above it has to know which one it got. A carrier is responsible
 * for delivery and for turning a returned `error` back into a thrown
 * `AppError`; it is responsible for nothing else, and in particular it never
 * inspects `params` or decides what a method means.
 */
export interface Carrier {
  /**
   * `host` is an instance id, and absent means "this install" - the same
   * asymmetry `HostScoped` has in `shared/routes.ts`, and for the same reason:
   * every call written before hosts existed is still the call it was.
   *
   * A carrier does not resolve it, look at it, or know what a host is. It puts
   * it on the envelope and hands it over; `core/hosts/router.ts` decides. What
   * a carrier *must* do is keep it out of anything it uses as an identity for
   * the request - a read-coalescing key that ignored the host would answer
   * "the repositories on `pc-wsl`" with the repositories on this Mac.
   */
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    host?: string
  ): Promise<RpcResult<M>>
}

/**
 * A carrier that answers with an outcome instead of throwing.
 *
 * The shape `window.gitwarren` exposes, and the reason is one property of
 * Electron's `contextBridge`: a promise rejected on the preload side is rebuilt
 * in the renderer as a plain `Error` with a `message` and nothing else. Custom
 * properties do not survive - so an `AppError` unwrapped in the preload arrived
 * in React with `code` and `fieldErrors` gone, which is every inline form error
 * in the app and the reason a duplicate path was reported in a banner rather
 * than under the input it was about.
 *
 * So the bridge carries a *value*, which survives intact, and `lib/api.ts`
 * calls `resultOf` in the renderer's own world where a thrown `AppError` is
 * still an `AppError`. That is the same rule the byte-stream carriers already
 * follow - a boundary that cannot carry an exception returns an outcome - and
 * it is why `resultOf` was written to be shared in the first place.
 *
 * A browser tab has no such boundary and could throw perfectly well; it hands
 * back outcomes anyway, because one shape means the renderer has one way of
 * asking rather than two.
 */
export interface BridgeCarrier {
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    host?: string
  ): Promise<RpcOutcome<RpcResult<M>>>
}

/**
 * Unwrap an outcome, or throw the error it carries.
 *
 * Shared so that every carrier fails the same way: a `NOT_FOUND` from a daemon
 * over `ssh` has to reach a React component as the same `AppError` a local call
 * would have thrown, or the screens would need a second set of error handling
 * for remote hosts.
 */
export function resultOf<T>(outcome: RpcOutcome<T>): T {
  if ('error' in outcome) throw deserializeAppError(outcome.error)
  return outcome.result
}

/**
 * The other direction: run something, and report how it went as a value.
 *
 * The inverse of `resultOf`, and it exists for the same reason `handleRequest`
 * in the dispatcher never throws - some boundaries cannot carry an exception,
 * so an outcome has to be the return value rather than the happy path.
 *
 * A byte stream is the obvious such boundary. Electron's `contextBridge` is the
 * surprising one: it rebuilds a rejection as a bare `Error` carrying `message`
 * and nothing else, so an `AppError` thrown on the preload side arrives in the
 * renderer with no `code` and no `fieldErrors`. See `BridgeCarrier`.
 */
export async function outcomeOf<T>(work: () => Promise<T>): Promise<RpcOutcome<T>> {
  try {
    return { result: await work() }
  } catch (error) {
    return { error: AppError.from(error).toSerialized() }
  }
}
