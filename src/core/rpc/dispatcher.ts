/**
 * Method name to service call, and nothing else.
 *
 * This is the one place that decides what "everything the core can do" means.
 * Every carrier - Electron IPC today, a stdio pipe in M2, a WebSocket in M3,
 * `ssh` in M4 - is a way of getting a `RpcRequest` to `handleRequest` and an
 * `RpcResponse` back. None of them may add a method, skip validation, or decide
 * who a comment belongs to. If a carrier grows logic, it is in the wrong file.
 *
 * Two properties are load-bearing and worth stating plainly.
 *
 * **The dispatcher is the human surface.** Every comment write here passes
 * `HUMAN_AUTHOR`, because the only way to reach a dispatcher is for someone to
 * be driving a GitWarren window. Agents do not come through here at all: the
 * MCP server imports `core/services` directly and passes an author derived from
 * its handshake (`mcp/identity.ts`). That is the whole enforcement mechanism
 * for "comments from the UI are the person's, comments over MCP are the
 * agent's", and it works because the actor is a property of the boundary rather
 * than a field a caller could set. Moving it here from `main/ipc.ts` changed
 * where the boundary is drawn, not what it guarantees.
 *
 * **The dispatcher has no capabilities.** It reads git and SQLite and that is
 * all. It cannot open a dialog, reveal a path, or start a process, because in
 * M4 the thing on the other end of a carrier is a daemon on someone else's
 * machine, and a request that could launch a process there would be a very
 * different piece of software. Shell capabilities live in `main/ipc.ts` and
 * never enter this map.
 */
import { emitForMethod } from '../events.js'
import { getInstanceId } from '../instance.js'
import { describeMcpLaunch } from '../mcp-launcher.js'
import { APP_VERSION } from '../version.js'
import { attachmentsService } from '../services/attachments.js'
import { commentsService } from '../services/comments.js'
import { fsService } from '../services/fs.js'
import { discoverPeers } from '../hosts/discover.js'
import { hostsService, tailnetService } from '../services/hosts.js'
import { repositoriesService } from '../services/repositories.js'
import { reviewedFilesService } from '../services/reviewed-files.js'
import { reviewsService } from '../services/reviews.js'
import { traced } from '../trace.js'
import { HUMAN_AUTHOR } from '../../shared/actors.js'
import { AppError } from '../../shared/errors.js'
import { RPC_PROTOCOL_VERSION } from '../../shared/rpc.js'
import type {
  AttachmentIngestParams,
  HostIdentity,
  ReviewOpen,
  RpcMethod,
  RpcParams,
  RpcRequest,
  RpcResponse,
  RpcResult
} from '../../shared/rpc.js'

/**
 * Everything needed to render a review, in one call.
 *
 * Three indexed reads that were three round trips. `reviews.get` runs first
 * because it is the one that decides whether the review exists at all: a
 * missing review should answer `NOT_FOUND` rather than an empty discussion.
 * After that the two lists are independent, so they cost the slowest rather
 * than the sum.
 */
async function openReview(params: unknown): Promise<ReviewOpen> {
  const review = await reviewsService.get(params)
  const [threads, reviewedFiles] = await Promise.all([
    commentsService.list({ reviewId: review.id }),
    reviewedFilesService.list({ reviewId: review.id })
  ])
  return { review, threads, reviewedFiles }
}

/**
 * Bytes on the way in.
 *
 * The only method whose params need touching before a service sees them, and
 * the reason is transport: `Buffer` is not something a renderer or a JSON
 * carrier can send, so an image arrives in whatever form its carrier could
 * manage and is turned back into bytes here, at the edge, once.
 *
 * Three forms, because there are two kinds of carrier. `ArrayBuffer` is what
 * the renderer sends and what Electron's structured clone preserves; it is also
 * exactly what `JSON.stringify` destroys, turning it into `{}`. So a carrier
 * over a byte stream sends base64, or the `number[]` a naive stringify of a
 * byte array produces. Which one arrived is decided here rather than by a flag
 * in the params: the shapes are already distinguishable, and a caller that had
 * to declare its encoding would be a caller that could declare it wrongly.
 *
 * The explicit rejection at the end matters more than it looks. Before M2 an
 * unrecognised shape reached `Buffer.from` and came back as an `INTERNAL` from
 * somewhere deep in the dispatcher - which over a pipe is indistinguishable
 * from the daemon being broken. It is an `INVALID_INPUT` naming the forms, so
 * the far end of an `ssh` connection can read what it did wrong.
 */
function toIngestSource(params: unknown): { bytes: Buffer; originalName?: string } {
  if (typeof params !== 'object' || params === null || !('bytes' in params)) {
    throw new AppError('INVALID_INPUT', 'An image is required.')
  }

  const { bytes, originalName } = params as AttachmentIngestParams
  const name = typeof originalName === 'string' ? { originalName } : {}

  // `base64` decoding ignores anything outside the alphabet rather than
  // throwing, so a string that is not base64 becomes a short buffer and fails
  // the format sniff in the service - which is the right place for it to fail.
  if (typeof bytes === 'string') return { bytes: Buffer.from(bytes, 'base64'), ...name }
  if (Array.isArray(bytes)) return { bytes: Buffer.from(bytes), ...name }
  if (bytes instanceof ArrayBuffer) return { bytes: Buffer.from(bytes), ...name }
  // A typed array, which is what a `Uint8Array` sent over structured clone
  // arrives as. Its own byte range, not the whole underlying buffer.
  if (ArrayBuffer.isView(bytes)) {
    return {
      bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ...name
    }
  }

  throw new AppError(
    'INVALID_INPUT',
    'An image must be sent as bytes: base64, an array of byte values, or an ArrayBuffer.'
  )
}

/**
 * This install, as a host sees it.
 *
 * Synchronous: the instance id is a cached file read and the version is a
 * build-time constant.
 *
 * Exported since M6.6 for one other caller: the discovery probe in
 * `core/web/handler.ts`, which answers the same shape over HTTP to a peer that
 * has no carrier yet. Shared rather than rebuilt, because "who is answering" is
 * one question and two answers to it would eventually disagree about a protocol
 * number.
 */
export function describeThisInstance(): HostIdentity {
  return {
    instanceId: getInstanceId(),
    protocol: RPC_PROTOCOL_VERSION,
    version: APP_VERSION
  }
}

/**
 * The map. Every entry is a one-line delegation, and that thinness is the
 * point: validation, path resolution and error semantics live in the service,
 * so the GUI, the daemon and the MCP server cannot disagree about what a valid
 * review is. Each service re-parses its own input, so `params` is deliberately
 * `unknown` all the way down to it.
 */
const handlers: {
  // Sync or async. `traced` has always accepted both, and better-sqlite3 is
  // synchronous, so a service whose work is one indexed read is telling the
  // truth by not being a promise - `hosts.list` and `app.instance` are the
  // first two that had no reason to pretend otherwise.
  [M in RpcMethod]: (params: unknown) => Promise<RpcResult<M>> | RpcResult<M>
} = {
  'app.instance': () => describeThisInstance(),
  'app.mcp': () => describeMcpLaunch(),

  // Answered by whoever is asked, and never forwarded onward - see the note on
  // these in `shared/rpc.ts`. They are in the map because a screen reaches the
  // core through the dispatcher and nowhere else, which is what lets the Hosts
  // screen work identically in the window and in a browser tab.
  'hosts.list': () => hostsService.list(),
  'hosts.get': (params) => hostsService.get(params),
  'hosts.add': (params) => hostsService.add(params),
  'hosts.update': (params) => hostsService.update(params),
  'hosts.remove': (params) => hostsService.remove(params),
  'hosts.probe': (params) => hostsService.probe(params),
  'hosts.install': (params) => hostsService.install(params),
  'hosts.distros': () => hostsService.distros(),
  // About this machine's own reachability, never a host's - `isLocalOnly`
  // refuses the whole prefix, which is what stops a GUI on one machine
  // starting `tailscale serve` on another. See the note in `shared/rpc.ts`.
  'hosts.discover': () => discoverPeers(),
  'hosts.tailnet': () => tailnetService.read(),
  'hosts.setTailnetExposure': (params) => tailnetService.set(params),

  // Answered by whoever owns the folder, which is the whole point of it being
  // a method - see the note in `shared/rpc.ts`.
  'fs.list': (params) => fsService.list(params),

  'repositories.list': () => repositoriesService.list(),
  'repositories.get': (params) => repositoriesService.get(params),
  'repositories.add': (params) => repositoriesService.add(params),
  'repositories.update': (params) => repositoriesService.update(params),
  'repositories.remove': (params) => repositoriesService.remove(params),
  'repositories.refs': (params) => repositoriesService.refs(params),

  'reviews.list': (params) => reviewsService.list(params),
  'reviews.open': (params) => openReview(params),
  'reviews.get': (params) => reviewsService.get(params),
  'reviews.create': (params) => reviewsService.create(params),
  'reviews.update': (params) => reviewsService.update(params),
  'reviews.remove': (params) => reviewsService.remove(params),
  'reviews.commits': (params) => reviewsService.commits(params),
  'reviews.diff': (params) => reviewsService.diff(params),
  'reviews.tree': (params) => reviewsService.tree(params),
  'reviews.file': (params) => reviewsService.file(params),
  'reviews.image': (params) => reviewsService.image(params),
  'reviews.filePath': (params) => reviewsService.absolutePath(params),

  // Reviewed marks are a record of what the person at the keyboard has read, so
  // they are reachable from a GitWarren window and from nowhere else. There is
  // deliberately no MCP tool for them: an agent claiming a human has reviewed a
  // file would make the one honest signal on the screen worthless.
  'reviews.reviewedFiles': (params) => reviewedFilesService.list(params),
  'reviews.setFileReviewed': (params) => reviewedFilesService.setReviewed(params),

  // `HUMAN_AUTHOR` on every write. See the note at the top of the file.
  'comments.list': (params) => commentsService.list(params),
  'comments.createThread': (params) => commentsService.createThread(params, HUMAN_AUTHOR),
  'comments.reply': (params) => commentsService.reply(params, HUMAN_AUTHOR),
  'comments.update': (params) => commentsService.update(params, HUMAN_AUTHOR),
  'comments.remove': (params) => commentsService.remove(params, HUMAN_AUTHOR),
  'comments.setResolved': (params) => commentsService.setResolved(params, HUMAN_AUTHOR),

  'attachments.ingest': (params) => attachmentsService.ingest(toIngestSource(params)),
  'attachments.read': (params) => attachmentsService.read(params)
}

/** Derived from the map above rather than written out again next to it. */
export const rpcMethodNames = Object.keys(handlers) as RpcMethod[]

export function isRpcMethod(method: string): method is RpcMethod {
  return Object.hasOwn(handlers, method)
}

/**
 * Answer one method, or throw an `AppError`.
 *
 * Typed for the callers that know which method they are asking for - the
 * renderer through its carrier, and the tests. `handleRequest` below is the
 * untyped door for a carrier holding a message off a wire.
 */
export async function dispatch<M extends RpcMethod>(
  method: M,
  params?: RpcParams<M>
): Promise<RpcResult<M>> {
  if (!isRpcMethod(method)) {
    // A caller bug locally; in M4, a host older than the GUI talking to it. The
    // message names the method so the second case is diagnosable from a log.
    throw new AppError('INVALID_INPUT', `Unknown method "${String(method)}".`)
  }

  try {
    // Traced here rather than in a carrier, so that counting round trips per
    // screen works the same however the request arrived - the measurement M1
    // exists to improve, and the one M4 will want again over a real network.
    const result = await traced(method, () => handlers[method](params))
    // After the work, never before: an event is a claim that something changed,
    // and a method that threw changed nothing. This is the human surface - see
    // the note at the top of this file - so it is exactly the writes a person
    // made. An agent's writes never pass here and announce themselves from the
    // MCP process instead.
    emitForMethod(method)
    return result
  } catch (error) {
    const appError = AppError.from(error)
    if (appError.code === 'INTERNAL') {
      // Unexpected failures are worth seeing in the terminal; every other code
      // is an ordinary user-facing outcome that the screen will render.
      console.error(`[ipc] ${method} failed`, error)
    }
    throw appError
  }
}

/**
 * A request in, a response out, never a throw - answered *here*.
 *
 * A carrier holding a byte stream has no way to report an exception - there is
 * only the wire - so every failure has to come back as a message. Errors keep
 * their `AppError` code and their field errors, which is what lets a form on
 * the other side of an `ssh` pipe still put a message under the right input.
 *
 * Carriers do not use this one. Since M4.3 they come through
 * `handleRoutedRequest` in `core/hosts/router.ts`, which honours the host on
 * the envelope and then arrives back here for everything that stays local. The
 * split is what keeps this file's promise true: the dispatcher decides what the
 * core can *do*, and has never had an opinion about which machine does it.
 */
export async function handleRequest(request: RpcRequest): Promise<RpcResponse> {
  try {
    return { id: request.id, result: await dispatch(request.method, request.params) }
  } catch (error) {
    return { id: request.id, error: AppError.from(error).toSerialized() }
  }
}
