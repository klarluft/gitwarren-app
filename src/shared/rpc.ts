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
import { deserializeAppError, type SerializedAppError } from './errors.js'
import type { FileContent, FileImage, RepositoryRefs, ReviewCommits, ReviewDiff } from './git.js'
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
  ListReviewedFilesInput,
  ListReviewsInput,
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

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  /** Unique per connection. Answers may come back in any order. */
  id: number
  method: M
  params?: RpcParams<M>
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
  'comments.list'
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
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
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
