/**
 * The renderer's view of the bridge, plus the SWR cache keys.
 *
 * Everything the UI can do goes through `window.gitwarren`, which the preload
 * script installed. There is no fetch client and no API base URL - see the
 * README on why this app talks over IPC rather than a local HTTP server.
 */
import type { GitWarrenApi } from '@shared/api'

if (typeof window.gitwarren === 'undefined') {
  throw new Error(
    'The GitWarren bridge is missing. This usually means the preload script failed to load.'
  )
}

export const api: GitWarrenApi = window.gitwarren

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
  appInfo: 'app-info',
  repositoryRefs: (repositoryId: number) => `repository-refs:${repositoryId}`,
  reviews: (repositoryId?: number, status?: string) =>
    `reviews:${repositoryId ?? 'all'}:${status ?? 'any'}`,
  review: (reviewId: number) => `review:${reviewId}`,
  reviewCommits: (reviewId: number) => `review-commits:${reviewId}`,
  reviewDiff: (reviewId: number, includeUncommitted: boolean) =>
    `review-diff:${reviewId}:${includeUncommitted ? 'with-uncommitted' : 'committed-only'}`,
  /**
   * Keyed by the same switch as the diff: expanded context read from the other
   * version of the file would not line up with the hunks it sits between.
   */
  reviewFile: (reviewId: number, path: string, includeUncommitted: boolean) =>
    `review-file:${reviewId}:${includeUncommitted ? 'with-uncommitted' : 'committed-only'}:${path}`,
  /** Installed code editors. Probed once per run; see `main/editors.ts`. */
  editors: 'editors',
  /**
   * Comments are keyed per review and *not* per diff view. They are a plain
   * database read, so the same list serves the conversation tab and both
   * settings of the files tab's "include uncommitted" switch; only the anchor
   * resolution differs between them, and that is computed in the component
   * from whichever diff it is showing.
   */
  reviewComments: (reviewId: number) => `review-comments:${reviewId}`
} as const

/** Prefixes used by the family-wide invalidation above. */
export const CACHE_PREFIXES = {
  reviews: 'reviews:',
  review: 'review:',
  reviewCommits: 'review-commits:',
  reviewDiff: 'review-diff:',
  reviewFile: 'review-file:',
  reviewComments: 'review-comments:'
} as const
