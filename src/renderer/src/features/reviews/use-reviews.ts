/**
 * Data access for the review screens.
 *
 * Same rule as `use-repositories`: SWR owns the cache and mutations revalidate
 * rather than patch it. That matters more here than it did for repositories,
 * because almost everything on these screens is live git state - the commit
 * list, the diff, whether a worktree is dirty. Patching a cached diff after
 * changing a review's base ref would be inventing an answer only git can give.
 *
 * The git-backed reads are deliberately *not* revalidated on focus or on an
 * interval. Re-running a diff on every window focus would spawn git processes
 * behind the user's back; the screens carry an explicit refresh button instead,
 * which is honest about when the app looks at the disk.
 */
import useSWR, { useSWRConfig, type SWRResponse } from 'swr'
import { useCallback, useMemo, useState } from 'react'
import { api, CACHE_KEYS, CACHE_PREFIXES } from '@/lib/api'
import { useApi, useHost } from '@/lib/host-scope'
import type { EditorList } from '@shared/api'
import type { ReviewOpen } from '@shared/rpc'
import type {
  DiffChanges,
  DiffFileSide,
  FileContent,
  FileImage,
  RepositoryRefs,
  ReviewCommits,
  ReviewDiff
} from '@shared/git'
import type {
  CommentThread,
  CreateReviewInput,
  Review,
  ReviewedFile,
  ReviewStatus,
  ReviewWithRepository,
  UpdateReviewInput
} from '@shared/schemas'

/** Applied to every git-backed read; see the note above. */
const LIVE_READ_OPTIONS = {
  revalidateOnFocus: false,
  revalidateIfStale: false,
  shouldRetryOnError: false
} as const

export interface ListState<T> {
  data: T | undefined
  error: unknown
  isLoading: boolean
  /** True during a background refresh, when stale data is still on screen. */
  isRefreshing: boolean
  refresh: () => Promise<unknown>
}

function toState<T>(result: {
  data: T | undefined
  error: unknown
  isLoading: boolean
  isValidating: boolean
  mutate: () => Promise<unknown>
}): ListState<T> {
  return {
    data: result.data,
    error: result.error,
    isLoading: result.isLoading,
    isRefreshing: result.isValidating && !result.isLoading,
    refresh: result.mutate
  }
}

export function useReviews(
  repositoryId: number | undefined,
  status?: ReviewStatus
): ListState<Review[]> {
  const api = useApi()
  const host = useHost()
  return toState(
    useSWR<Review[], unknown>(CACHE_KEYS.reviews(repositoryId, status, host), () =>
      api.reviews.list({
        ...(repositoryId === undefined ? {} : { repositoryId }),
        ...(status === undefined ? {} : { status })
      })
    )
  )
}

/**
 * A whole review in one read: the review itself, its discussion, and which of
 * its files have been ticked off.
 *
 * One hook and one cache key behind all three, which is what makes opening a
 * review a single round trip. Every consumer - the header, the conversation
 * tab, the files tab - subscribes to the same key, so however many of them
 * mount at once, SWR issues one request. Before M1 these were three keys and
 * three calls, and the second and third were pure overhead over a network.
 *
 * Revalidated on focus and every fifteen seconds, because the discussion is in
 * it: agents write to the same database from their own processes, and a stale
 * thread list is the one thing this screen must not show. The review row and
 * the marks come along for free - all three are indexed queries, and asking for
 * them separately would cost a round trip each.
 */
function useReviewOpen(reviewId: number): SWRResponse<ReviewOpen, unknown> {
  const api = useApi()
  const host = useHost()
  return useSWR<ReviewOpen, unknown>(
    CACHE_KEYS.review(reviewId, host),
    () => api.reviews.open({ id: reviewId }),
    { revalidateOnFocus: true, refreshInterval: 15_000 }
  )
}

export function useReview(reviewId: number): ListState<ReviewWithRepository> {
  const result = useReviewOpen(reviewId)
  return toState({ ...result, data: result.data?.review })
}

/** The discussion. See `useReviewOpen` for why this is not a read of its own. */
export function useReviewThreads(reviewId: number): ListState<CommentThread[]> {
  const result = useReviewOpen(reviewId)
  return toState({ ...result, data: result.data?.threads })
}

export function useReviewCommits(reviewId: number): ListState<ReviewCommits> {
  const api = useApi()
  const host = useHost()
  return toState(
    useSWR<ReviewCommits, unknown>(
      CACHE_KEYS.reviewCommits(reviewId, host),
      () => api.reviews.commits({ id: reviewId }),
      LIVE_READ_OPTIONS
    )
  )
}

/**
 * The diff a review opens on, and the one both tabs ask for first.
 *
 * Shared rather than written out three times, because the review screen starts
 * this read before either tab exists (see `review-detail.tsx`). A tab that
 * defaulted to a different setting would silently make that head start useless
 * and cost the extra round trip it was there to save.
 */
export const DEFAULT_DIFF_CHANGES: DiffChanges = 'all'

export function useReviewDiff(reviewId: number, changes: DiffChanges): ListState<ReviewDiff> {
  const api = useApi()
  const host = useHost()
  return toState(
    useSWR<ReviewDiff, unknown>(
      CACHE_KEYS.reviewDiff(reviewId, changes, host),
      () => api.reviews.diff({ id: reviewId, changes }),
      LIVE_READ_OPTIONS
    )
  )
}

export interface FileContentState {
  content: FileContent | undefined
  error: unknown
  isLoading: boolean
  /** True once `load` has been called; the read is not started before that. */
  requested: boolean
  /** Ask for the file. Idempotent - later calls are no-ops. */
  load: () => void
}

/**
 * One file of the diff, read whole so its hidden lines can be unfolded.
 *
 * Nothing is read until the reviewer asks for it. Files-changed renders every
 * file on screen at once, and reading each one up front would mean a git
 * process per file for context most reviewers never open.
 */
export function useReviewFile(
  /** Null for a file that cannot be expanded at all - binary, deleted, clipped. */
  reviewId: number | null,
  path: string,
  changes: DiffChanges
): FileContentState {
  const api = useApi()
  const host = useHost()
  const [requested, setRequested] = useState(false)
  const result = useSWR<FileContent, unknown>(
    requested && reviewId !== null ? CACHE_KEYS.reviewFile(reviewId, path, changes, host) : null,
    () => api.reviews.file({ id: reviewId as number, path, changes }),
    LIVE_READ_OPTIONS
  )

  return {
    content: result.data,
    error: result.error,
    isLoading: result.isLoading,
    requested,
    load: useCallback(() => setRequested(true), [])
  }
}

/**
 * One side of an image in the diff, as a `data:` URL.
 *
 * Read as soon as it is asked for, unlike the text of a file: the caller is a
 * preview that is already on screen, so there is nothing to defer. A null path
 * means this side of the change has no image at all - a new file has no base,
 * a deleted one has no head - and skips the read entirely.
 */
export function useReviewImage(
  reviewId: number,
  path: string | null,
  side: DiffFileSide,
  changes: DiffChanges
): { image: FileImage | undefined; error: unknown; isLoading: boolean } {
  const api = useApi()
  const host = useHost()
  const result = useSWR<FileImage, unknown>(
    path === null ? null : CACHE_KEYS.reviewImage(reviewId, path, side, changes, host),
    () => api.reviews.image({ id: reviewId, path: path as string, side, changes }),
    LIVE_READ_OPTIONS
  )

  return { image: result.data, error: result.error, isLoading: result.isLoading }
}

/**
 * Code editors this machine has. Probed in the main process and cached there
 * for the run, so this is a single read shared by every file card.
 */
export function useEditors(): EditorList | undefined {
  return useSWR<EditorList, unknown>(CACHE_KEYS.editors, () => api.system.editors(), {
    ...LIVE_READ_OPTIONS,
    revalidateOnMount: true
  }).data
}

/** Branches, tags and worktrees for the endpoint pickers. */
export function useRepositoryRefs(repositoryId: number | null): ListState<RepositoryRefs> {
  const api = useApi()
  const host = useHost()
  return toState(
    useSWR<RepositoryRefs, unknown>(
      repositoryId === null ? null : CACHE_KEYS.repositoryRefs(repositoryId, host),
      () => api.repositories.refs({ id: repositoryId as number }),
      LIVE_READ_OPTIONS
    )
  )
}

const NO_REVIEWED_FILES: ReviewedFile[] = []

export interface ReviewedFilesState {
  /**
   * The digest stored for each ticked-off file, keyed by path.
   *
   * Digests rather than booleans, because a mark only counts while the file
   * still hashes to the same value - see `shared/diff-digest.ts`. The caller
   * compares them against the diff it is rendering, which is the only diff
   * anyone can claim to have read.
   */
  digests: Map<string, string>
  isLoading: boolean
  /** Tick a file off against a digest, or clear the tick with a null one. */
  setReviewed: (filePath: string, contentDigest: string | null) => Promise<void>
}

/**
 * Which files of a review have been read, and the writer that changes it.
 *
 * Marking is optimistic. Ticking a file off happens in the middle of reading a
 * diff, often from the keyboard, and waiting a round trip for the tick to
 * appear - or worse, for the card to fold - would make the gesture feel
 * broken. The write is one indexed upsert against a local SQLite file, so the
 * optimistic state is almost always the state that lands; a failure rolls back
 * and revalidates, which is the same read the screen already trusts.
 */
export function useReviewedFiles(reviewId: number): ReviewedFilesState {
  const api = useApi()
  const { data, isLoading, mutate } = useReviewOpen(reviewId)

  const files = data?.reviewedFiles ?? NO_REVIEWED_FILES

  const digests = useMemo(
    () => new Map(files.map((file) => [file.filePath, file.contentDigest])),
    [files]
  )

  const setReviewed = useCallback(
    async (filePath: string, contentDigest: string | null) => {
      // Nothing on screen to patch - the review has not arrived yet. Write, then
      // let the ordinary read bring the mark back with everything else.
      if (!data) {
        await api.reviews.setFileReviewed({ reviewId, filePath, contentDigest })
        await mutate()
        return
      }

      // The marks live inside the opened review now, so the optimistic update
      // replaces that one field and leaves the review and its threads alone.
      const others = data.reviewedFiles.filter((file) => file.filePath !== filePath)
      const next: ReviewOpen = {
        ...data,
        reviewedFiles:
          contentDigest === null
            ? others
            : [...others, { reviewId, filePath, contentDigest, reviewedAt: new Date().toISOString() }]
      }

      await mutate(
        async () => {
          await api.reviews.setFileReviewed({ reviewId, filePath, contentDigest })
          return next
        },
        { optimisticData: next, revalidate: false, rollbackOnError: true }
      )
    },
    [api, data, mutate, reviewId]
  )

  return { digests, isLoading, setReviewed }
}

export interface ReviewMutations {
  createReview: (input: CreateReviewInput) => Promise<Review>
  updateReview: (input: UpdateReviewInput) => Promise<Review>
  removeReview: (id: number) => Promise<void>
}

export function useReviewMutations(): ReviewMutations {
  const api = useApi()
  const { mutate } = useSWRConfig()

  // Every review family at once: a change to one review can move it between
  // filtered lists and invalidates its own git-backed reads.
  const revalidate = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          Object.values(CACHE_PREFIXES).some((prefix) => key.startsWith(prefix))
      ),
    [mutate]
  )

  return {
    createReview: useCallback(
      async (input) => {
        const created = await api.reviews.create(input)
        await revalidate()
        return created
      },
      [api, revalidate]
    ),
    updateReview: useCallback(
      async (input) => {
        const updated = await api.reviews.update(input)
        await revalidate()
        return updated
      },
      [api, revalidate]
    ),
    removeReview: useCallback(
      async (id) => {
        await api.reviews.remove({ id })
        await revalidate()
      },
      [api, revalidate]
    )
  }
}
