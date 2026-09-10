/**
 * The renderer's view of the app, and the SWR cache keys.
 *
 * `window.gitwarren` is no longer the API - it is a carrier plus the Electron
 * shell (see `shared/api.ts`). The API is assembled here, on top of it, and
 * that indirection is the whole of M1 as far as a screen is concerned: every
 * object method below is one `carrier.request`, so the day a browser tab
 * supplies a WebSocket carrier instead of the IPC one, nothing above this file
 * changes. There is still no fetch client and no API base URL.
 */
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

export const api: GitWarrenApi = {
  repositories: {
    list: () => carrier.request('repositories.list', undefined),
    get: (input) => carrier.request('repositories.get', input),
    add: (input) => carrier.request('repositories.add', input),
    update: (input) => carrier.request('repositories.update', input),
    remove: (input) => carrier.request('repositories.remove', input),
    refs: (input) => carrier.request('repositories.refs', input)
  },
  reviews: {
    list: (input) => carrier.request('reviews.list', input),
    open: (input) => carrier.request('reviews.open', input),
    get: (input) => carrier.request('reviews.get', input),
    create: (input) => carrier.request('reviews.create', input),
    update: (input) => carrier.request('reviews.update', input),
    remove: (input) => carrier.request('reviews.remove', input),
    commits: (input) => carrier.request('reviews.commits', input),
    diff: (input) => carrier.request('reviews.diff', input),
    file: (input) => carrier.request('reviews.file', input),
    image: (input) => carrier.request('reviews.image', input),
    reviewedFiles: (input) => carrier.request('reviews.reviewedFiles', input),
    setFileReviewed: (input) => carrier.request('reviews.setFileReviewed', input),
    // Where the file is comes from whoever owns the review; opening it is the
    // shell's job. The two halves are joined in the main process.
    openInEditor: (input) => shell.openInEditor(input)
  },
  comments: {
    list: (input) => carrier.request('comments.list', input),
    createThread: (input) => carrier.request('comments.createThread', input),
    reply: (input) => carrier.request('comments.reply', input),
    update: (input) => carrier.request('comments.update', input),
    remove: (input) => carrier.request('comments.remove', input),
    setResolved: (input) => carrier.request('comments.setResolved', input)
  },
  attachments: {
    ingest: (input) => carrier.request('attachments.ingest', input),
    pick: () => shell.pickAttachment()
  },
  system: {
    pickDirectory: () => shell.system.pickDirectory(),
    revealPath: (path) => shell.system.revealPath(path),
    appInfo: once(() => shell.system.appInfo()),
    editors: once(() => shell.system.editors())
  },
  navigation: shell.navigation,
  updates: shell.updates
}

/**
 * SWR cache keys.
 *
 * The review keys are prefixed strings rather than tuples so that a mutation
 * can invalidate a whole family at once - `mutate(key => key.startsWith('reviews:'))`
 * refreshes every list regardless of which repository or status filter it was
 * built with, which is what you want after creating or closing a review.
 */
export const CACHE_KEYS = {
  repositories: 'repositories',
  repositoryRefs: (repositoryId: number) => `repository-refs:${repositoryId}`,
  reviews: (repositoryId?: number, status?: string) =>
    `reviews:${repositoryId ?? 'all'}:${status ?? 'any'}`,
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
  review: (reviewId: number) => `review:${reviewId}`,
  reviewCommits: (reviewId: number) => `review-commits:${reviewId}`,
  reviewDiff: (reviewId: number, changes: DiffChanges) => `review-diff:${reviewId}:${changes}`,
  /**
   * Keyed by the same setting as the diff: expanded context read from another
   * version of the file would not line up with the hunks it sits between.
   */
  reviewFile: (reviewId: number, path: string, changes: DiffChanges) =>
    `review-file:${reviewId}:${changes}:${path}`,
  /**
   * One side of an image preview, keyed by the same setting for the same
   * reason: which version of the picture is "before" depends on what the diff
   * is made of.
   */
  reviewImage: (reviewId: number, path: string, side: string, changes: DiffChanges) =>
    `review-image:${reviewId}:${changes}:${side}:${path}`,
  /**
   * The two reads that never change while the app runs. They keep keys so the
   * components that show them keep a loading state, but the reads underneath
   * are memoised in `api` above and happen at most once per window.
   */
  appInfo: 'app-info',
  editors: 'editors'
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
