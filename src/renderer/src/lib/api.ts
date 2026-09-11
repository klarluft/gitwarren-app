/**
 * The renderer's view of the app, and the SWR cache keys.
 *
 * `window.gitwarren` is no longer the API - it is a carrier plus the Electron
 * shell (see `shared/api.ts`). The API is assembled here, on top of it, and
 * that indirection is the whole of M1 as far as a screen is concerned: every
 * object method below is one `carrier.request`, so the day a browser tab
 * supplies a WebSocket carrier instead of the IPC one, nothing above this file
 * changes. There is still no fetch client and no API base URL.
 *
 * ## Since M4.3 there is one of these per machine
 *
 * `apiFor(host)` binds every method to an install, and `api` is `apiFor()` -
 * this one. A screen never passes a host to a call; it uses the api it was
 * handed, and `useApi()` in `lib/host-scope.tsx` hands it the one the current
 * route is about. Which is why nothing in `features/` had to learn what a host
 * is: `api.reviews.diff(...)` on a host-scoped screen already means "on that
 * host", because the object it was called on says so.
 *
 * Binding rather than a parameter also keeps a whole class of bug out of reach.
 * A host threaded through as an argument is a host that can be *forgotten* at
 * one call site out of forty, and the failure mode of forgetting it is silent:
 * the local answer, rendered under a remote heading. There is no argument to
 * forget.
 *
 * The shell half is not bound to anything and never will be. Revealing a path,
 * opening a picker, launching an editor: those happen on the machine with the
 * screen on it, whatever the screen is showing. See `ShellCapabilities`.
 *
 * ## Where a failure becomes a thrown `AppError`
 *
 * Here, in `ask` below, and that is a fix rather than a detail. The bridge hands
 * back an `RpcOutcome` because `contextBridge` cannot carry an exception with
 * anything on it - see `BridgeCarrier` in `shared/rpc.ts` - so the unwrapping
 * has to happen on this side of it, in the renderer's own world, where a thrown
 * `AppError` is still an `AppError` with its `code` and its `fieldErrors`. That
 * is what `errorCode` and `firstFieldError` read, and it is why a duplicate
 * repository path can appear under the path input again.
 */
import { resultOf, type RpcMethod, type RpcParams, type RpcResult } from '@shared/rpc'
import { errorMessage, isDisconnection } from './errors'
import { reportHostAnswered, reportHostUnreachable } from './host-reachability'
import type { GitWarrenApi, GitWarrenBridge } from '@shared/api'
import type { DiffChanges } from '@shared/git'

if (typeof window.gitwarren === 'undefined') {
  throw new Error(
    'The GitWarren bridge is missing. This usually means the preload script failed to load.'
  )
}

const bridge: GitWarrenBridge = window.gitwarren
const { carrier, shell } = bridge

/**
 * One carrier call, unwrapped.
 *
 * Every method below goes through this rather than calling `carrier.request`
 * directly, so there is exactly one place where an outcome becomes a value or a
 * throw. `resultOf` is the shared unwrapper every carrier uses, which is what
 * makes a `NOT_FOUND` from a daemon over `ssh` reach a component as the same
 * `AppError` a local call would have thrown.
 *
 * It is also where M4.5 learns which machines are still answering. Every
 * question this window asks of another computer passes through here with the
 * host still in scope, which makes it the one place that can notice a machine
 * going away without anybody having to push anything - see
 * `lib/host-reachability.ts` for why that is the signal rather than the pool's
 * own `onStateChange`.
 */
function ask<M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
  host?: string
): Promise<RpcResult<M>> {
  const answered = carrier.request(method, params, host).then(resultOf)
  // Nothing to observe about this install. A local call cannot be a
  // disconnection, and there is no banner for one to raise.
  if (host === undefined) return answered

  return answered.then(
    (result) => {
      reportHostAnswered(host)
      return result
    },
    (error: unknown) => {
      // Only a transport failure says anything about the machine - the rule the
      // pool applies before touching its backoff ladder, arriving at the other
      // end of the same wire. A `NOT_FOUND` is proof the far end is there.
      if (isDisconnection(error)) reportHostUnreachable(host, errorMessage(error))
      else reportHostAnswered(host)
      throw error
    }
  )
}

/**
 * Ask once, for the life of the window.
 *
 * The app's version, where its database is, and which editors are installed do
 * not change while it is running - the editor list is already probed once and
 * cached in the main process. They were nonetheless being re-read on every
 * navigation, because a component that unmounts and comes back asks again.
 * Holding the promise rather than the value means even two callers racing on
 * the first render share one call. See spike S5 in docs/across-hosts.md.
 */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= read())
}

/**
 * The api objects handed out so far, by host.
 *
 * Memoised because these end up in `useMemo` dependency lists and in SWR
 * fetchers: a fresh object every render would make every one of those look like
 * a change. `''` stands for this install, since `undefined` is not a key.
 */
const byHost = new Map<string, GitWarrenApi>()

/**
 * The app, as reached on one machine.
 *
 * `host` is an instance id, and omitting it means this install - the same
 * asymmetry the routes have, and the reason a call written before hosts existed
 * still means what it meant.
 */
export function apiFor(host?: string): GitWarrenApi {
  const cached = byHost.get(host ?? '')
  if (cached) return cached
  const built = buildApi(host)
  byHost.set(host ?? '', built)
  return built
}

function buildApi(host: string | undefined): GitWarrenApi {
  return {
    // Read once, at module scope, because it is read during render and cannot
    // change while the page is open. A screen asks `api.capabilities.revealPath`
    // and leaves the button out; see `ShellCapabilities` on why that is better
    // than a button that explains itself when pressed.
    //
    // Not scoped by host, and that is not an omission: these describe the shell
    // the person is *using*, which does not change because the screen is
    // showing another machine. What a remote screen must not do with them is a
    // separate question, and the screens answer it - `revealPath` on a path
    // that only exists on `pc-wsl` would open a Finder window on nothing.
    capabilities: shell.capabilities,
    // Deliberately unbound even here. A host's list of hosts is its own
    // business, and the carrier refuses to send one; passing `host` would build
    // a request that could only ever be refused. See `isLocalOnly`.
    hosts: {
      list: () => ask('hosts.list', undefined),
      get: (input) => ask('hosts.get', input),
      add: (input) => ask('hosts.add', input),
      update: (input) => ask('hosts.update', input),
      remove: (input) => ask('hosts.remove', input),
      probe: (input) => ask('hosts.probe', input),
      install: (input) => ask('hosts.install', input),
      distros: () => ask('hosts.distros', undefined),
      // Unbound like the rest of `hosts`, and here the binding would be
      // actively wrong rather than merely refused: this is about the
      // reachability of the machine holding the core, which in a browser tab
      // is the machine that served the tab and never the one a route names.
      tailnet: () => ask('hosts.tailnet', undefined),
      setTailnetExposure: (input) => ask('hosts.setTailnetExposure', input)
    },
    fs: {
      list: (input) => ask('fs.list', input, host)
    },
    app: {
      // Not memoised the way `system.appInfo` is. That one is about the install
      // behind this window and cannot change while it is open; this one is about
      // whichever machine a route names, and a host whose daemon has just been
      // installed has a launcher it did not have a minute ago.
      mcp: () => ask('app.mcp', undefined, host)
    },
    repositories: {
      list: () => ask('repositories.list', undefined, host),
      get: (input) => ask('repositories.get', input, host),
      add: (input) => ask('repositories.add', input, host),
      update: (input) => ask('repositories.update', input, host),
      remove: (input) => ask('repositories.remove', input, host),
      refs: (input) => ask('repositories.refs', input, host)
    },
    reviews: {
      list: (input) => ask('reviews.list', input, host),
      open: (input) => ask('reviews.open', input, host),
      get: (input) => ask('reviews.get', input, host),
      create: (input) => ask('reviews.create', input, host),
      update: (input) => ask('reviews.update', input, host),
      remove: (input) => ask('reviews.remove', input, host),
      commits: (input) => ask('reviews.commits', input, host),
      diff: (input) => ask('reviews.diff', input, host),
      file: (input) => ask('reviews.file', input, host),
      image: (input) => ask('reviews.image', input, host),
      reviewedFiles: (input) => ask('reviews.reviewedFiles', input, host),
      setFileReviewed: (input) => ask('reviews.setFileReviewed', input, host),
      // Where the file is comes from whoever owns the review; opening it is the
      // shell's job, on the machine the person is sitting at. The two halves
      // are joined in the main process, which since M4.4 is handed the host so
      // it can ask the right machine for the path and then tell a local editor
      // that the path is over there. The host travels in the input rather than
      // binding the shell, because the shell is not the thing that is remote.
      openInEditor: (input) => shell.openInEditor({ ...input, ...(host === undefined ? {} : { host }) })
    },
    comments: {
      list: (input) => ask('comments.list', input, host),
      createThread: (input) => ask('comments.createThread', input, host),
      reply: (input) => ask('comments.reply', input, host),
      update: (input) => ask('comments.update', input, host),
      remove: (input) => ask('comments.remove', input, host),
      setResolved: (input) => ask('comments.setResolved', input, host)
    },
    attachments: {
      ingest: (input) => ask('attachments.ingest', input, host),
      // The picker is the shell's and the bytes are the store's, and since
      // M4.4 those can be two different machines: a file chosen here is
      // ingested wherever the review lives. That is why this one is bound like
      // a read rather than left with the rest of the shell.
      pick: () => shell.pickAttachment(host),
      src: (url) => shell.attachmentSrc(url, host)
    },
    system: {
      pickDirectory: () => shell.system.pickDirectory(),
      revealPath: (path) => shell.system.revealPath(path),
      appInfo: once(() => shell.system.appInfo()),
      editors: once(() => shell.system.editors()),
      // Not memoised, unlike the two above: the user can turn this on in System
      // Settings while the window is open, and a value cached for the life of the
      // document would show them a switch that disagrees with their machine.
      getOpenAtLogin: () => shell.system.getOpenAtLogin(),
      setOpenAtLogin: (openAtLogin) => shell.system.setOpenAtLogin(openAtLogin)
    },
    navigation: shell.navigation,
    updates: shell.updates,
    // Unbound like the two above, and for the same reason: it is about the
    // shell the person is using, not about any machine a route names. A tab
    // that has lost its socket has lost it for every screen at once.
    connection: shell.connection
  }
}

/** This install. What every screen used before there was more than one. */
export const api: GitWarrenApi = apiFor()

/**
 * Tie a cache key to the machine its answer came from.
 *
 * Every id in this app is a per-host autoincrement integer, which is the point
 * `shared/routes.ts` makes about links and is just as true of a cache: review 4
 * here and review 4 on `pc-wsl` are two different reviews, and one key for both
 * would put one machine's discussion under the other machine's heading. This is
 * the same argument as the read-coalescing key in the carrier, one layer up.
 *
 * The host goes on the *end*, after the prefix, so that the family-wide
 * invalidation below still works by `startsWith`. Invalidating `reviews:` then
 * covers every host at once, which is the honest thing after a write: nothing
 * unmounted refetches until it is looked at again, and what is on screen is one
 * host's worth of reads.
 */
function scoped(key: string, host: string | undefined): string {
  return host === undefined ? key : `${key}@${host}`
}

/**
 * SWR cache keys.
 *
 * The review keys are prefixed strings rather than tuples so that a mutation
 * can invalidate a whole family at once - `mutate(key => key.startsWith('reviews:'))`
 * refreshes every list regardless of which repository or status filter it was
 * built with, which is what you want after creating or closing a review.
 *
 * Every key that names something a host owns takes that host as its last
 * argument, and omitting it means this install - so a call site that predates
 * hosts produces the string it always did.
 */
export const CACHE_KEYS = {
  /**
   * One key for the whole list, like `repositories`.
   *
   * There is no per-host key on purpose. A host row carries live reachability,
   * so anything that changes one host's state has almost certainly changed the
   * neighbours' too - a laptop closing its lid takes every host on that tailnet
   * with it - and re-reading the list is one local SQLite read plus a lookup in
   * the pool. Splitting it would buy nothing and would let two rows on one
   * screen disagree about what time it is.
   */
  hosts: 'hosts',
  /** What could become a host here. Unscoped, like the host list itself. */
  distros: 'wsl-distros',
  /**
   * Whether this machine is reachable on its tailnet.
   *
   * Unscoped for the same reason as the two above: it is about the install
   * this window is driving, not about any machine a route happens to name.
   */
  tailnet: 'tailnet',
  repositories: (host?: string) => scoped('repositories', host),
  repository: (repositoryId: number, host?: string) =>
    scoped(`repository:${repositoryId}`, host),
  repositoryRefs: (repositoryId: number, host?: string) =>
    scoped(`repository-refs:${repositoryId}`, host),
  /** One folder of one machine's filesystem, as the browse dialog sees it. */
  directory: (path: string | undefined, host?: string) =>
    scoped(`directory:${path ?? ''}`, host),
  reviews: (repositoryId?: number, status?: string, host?: string) =>
    scoped(`reviews:${repositoryId ?? 'all'}:${status ?? 'any'}`, host),
  /**
   * A whole review, as `reviews.open` answers it: the review itself, its
   * threads and its reviewed marks.
   *
   * One key for all three, and that is the point rather than a convenience. The
   * three used to be three keys, which meant three fetches whenever a review
   * was opened, three chances for one of them to be revalidated on its own, and
   * three round trips once a carrier is a network. Now the review screen, the
   * conversation tab and the files tab all subscribe to this one key, and SWR
   * turns that into a single request no matter how many of them mount at once.
   *
   * The 15-second poll and the focus revalidation run against it too, so a
   * refresh brings back the discussion, the marks and any change to the review
   * itself together - one request where there used to be two.
   */
  review: (reviewId: number, host?: string) => scoped(`review:${reviewId}`, host),
  reviewCommits: (reviewId: number, host?: string) =>
    scoped(`review-commits:${reviewId}`, host),
  reviewDiff: (reviewId: number, changes: DiffChanges, host?: string) =>
    scoped(`review-diff:${reviewId}:${changes}`, host),
  /**
   * Keyed by the same setting as the diff: expanded context read from another
   * version of the file would not line up with the hunks it sits between.
   */
  reviewFile: (reviewId: number, path: string, changes: DiffChanges, host?: string) =>
    scoped(`review-file:${reviewId}:${changes}:${path}`, host),
  /**
   * One side of an image preview, keyed by the same setting for the same
   * reason: which version of the picture is "before" depends on what the diff
   * is made of.
   */
  reviewImage: (
    reviewId: number,
    path: string,
    side: string,
    changes: DiffChanges,
    host?: string
  ) => scoped(`review-image:${reviewId}:${changes}:${side}:${path}`, host),
  /**
   * The two reads that never change while the app runs. They keep keys so the
   * components that show them keep a loading state, but the reads underneath
   * are memoised in `api` above and happen at most once per window.
   */
  appInfo: 'app-info',
  /**
   * How an agent reaches one machine's MCP server.
   *
   * Scoped, unlike `appInfo`, and that is the difference between the two: this
   * is a fact about the machine a route names, and the Agent Access page for
   * `pc-wsl` must never be handed this Mac's launcher path. It is the whole
   * failure the page exists to avoid - an instruction that is confidently the
   * wrong one.
   */
  agentMcp: (host?: string) => scoped('agent-mcp', host),
  editors: 'editors',
  /**
   * Whether GitWarren starts with the machine. Not one of the two above: it can
   * change while the window is open, and it changes outside the app - so it has
   * a key of its own and is revalidated like anything else.
   */
  openAtLogin: 'open-at-login'
} as const

/** Prefixes used by the family-wide invalidation above. */
export const CACHE_PREFIXES = {
  reviews: 'reviews:',
  /** Covers the threads and the reviewed marks too - they live under this key. */
  review: 'review:',
  reviewCommits: 'review-commits:',
  reviewDiff: 'review-diff:',
  reviewFile: 'review-file:',
  reviewImage: 'review-image:'
} as const
