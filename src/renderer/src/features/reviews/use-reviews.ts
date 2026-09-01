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
import useSWR, { useSWRConfig } from 'swr'
import { useCallback, useState } from 'react'
import { api, CACHE_KEYS, CACHE_PREFIXES } from '@/lib/api'
import type { EditorList } from '@shared/api'
import type { FileContent, RepositoryRefs, ReviewCommits, ReviewDiff } from '@shared/git'
import type {
  CreateReviewInput,
  Review,
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
  return toState(
    useSWR<Review[], unknown>(CACHE_KEYS.reviews(repositoryId, status), () =>
      api.reviews.list({
        ...(repositoryId === undefined ? {} : { repositoryId }),
        ...(status === undefined ? {} : { status })
      })
    )
  )
}

export function useReview(reviewId: number): ListState<ReviewWithRepository> {
  return toState(
    useSWR<ReviewWithRepository, unknown>(CACHE_KEYS.review(reviewId), () =>
      api.reviews.get({ id: reviewId })
    )
  )
}

export function useReviewCommits(reviewId: number): ListState<ReviewCommits> {
  return toState(
    useSWR<ReviewCommits, unknown>(
      CACHE_KEYS.reviewCommits(reviewId),
      () => api.reviews.commits({ id: reviewId }),
      LIVE_READ_OPTIONS
    )
  )
}

export function useReviewDiff(reviewId: number, includeUncommitted: boolean): ListState<ReviewDiff> {
  return toState(
    useSWR<ReviewDiff, unknown>(
      CACHE_KEYS.reviewDiff(reviewId, includeUncommitted),
      () => api.reviews.diff({ id: reviewId, includeUncommitted }),
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
  includeUncommitted: boolean
): FileContentState {
  const [requested, setRequested] = useState(false)
  const result = useSWR<FileContent, unknown>(
    requested && reviewId !== null
      ? CACHE_KEYS.reviewFile(reviewId, path, includeUncommitted)
      : null,
    () => api.reviews.file({ id: reviewId as number, path, includeUncommitted }),
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
  return toState(
    useSWR<RepositoryRefs, unknown>(
      repositoryId === null ? null : CACHE_KEYS.repositoryRefs(repositoryId),
      () => api.repositories.refs({ id: repositoryId as number }),
      LIVE_READ_OPTIONS
    )
  )
}

export interface ReviewMutations {
  createReview: (input: CreateReviewInput) => Promise<Review>
  updateReview: (input: UpdateReviewInput) => Promise<Review>
  removeReview: (id: number) => Promise<void>
}

export function useReviewMutations(): ReviewMutations {
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
      [revalidate]
    ),
    updateReview: useCallback(
      async (input) => {
        const updated = await api.reviews.update(input)
        await revalidate()
        return updated
      },
      [revalidate]
    ),
    removeReview: useCallback(
      async (id) => {
        await api.reviews.remove({ id })
        await revalidate()
      },
      [revalidate]
    )
  }
}
