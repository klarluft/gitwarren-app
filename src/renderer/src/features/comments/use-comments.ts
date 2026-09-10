/**
 * Data access for review comments.
 *
 * The read itself lives next door, in `useReviewThreads`: since M1 the
 * discussion arrives as part of `reviews.open`, together with the review and
 * its reviewed marks, so opening a review is one round trip rather than three.
 * What is left here is the writing half.
 *
 * Unlike the commit and diff reads, the discussion *is* revalidated on focus
 * and on an interval, and that difference is deliberate. The git reads are
 * expensive and spawn processes, so the app waits to be asked. This one is an
 * indexed SQLite query against a database another process is actively writing
 * to - every agent working the review writes through the MCP server - so the
 * cost of checking is nil and the cost of not checking is reading a discussion
 * that moved on while the window was in the background.
 */
import { useSWRConfig } from 'swr'
import { useCallback } from 'react'
import { api, CACHE_PREFIXES } from '@/lib/api'
import { useReviewThreads } from '@/features/reviews/use-reviews'
import type {
  Comment,
  CommentThread,
  CreateThreadInput,
  ReplyToThreadInput
} from '@shared/schemas'

export interface CommentsState {
  threads: CommentThread[]
  error: unknown
  isLoading: boolean
  refresh: () => Promise<unknown>
}

const EMPTY: CommentThread[] = []

export function useReviewComments(reviewId: number): CommentsState {
  const { data, error, isLoading, refresh } = useReviewThreads(reviewId)
  return { threads: data ?? EMPTY, error, isLoading, refresh }
}

export interface CommentMutations {
  createThread: (input: CreateThreadInput) => Promise<CommentThread>
  reply: (input: ReplyToThreadInput) => Promise<Comment>
  edit: (id: number, body: string) => Promise<Comment>
  remove: (id: number) => Promise<void>
  setResolved: (threadId: number, resolved: boolean) => Promise<void>
}

export function useCommentMutations(): CommentMutations {
  const { mutate } = useSWRConfig()

  // A comment also bumps its review's `updatedAt`, which reorders every review
  // list, so the whole family is revalidated rather than just this review. The
  // `review:` prefix now covers the thread list, which lives under that key.
  const revalidate = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith(CACHE_PREFIXES.reviews) || key.startsWith(CACHE_PREFIXES.review))
      ),
    [mutate]
  )

  return {
    createThread: useCallback(
      async (input) => {
        const thread = await api.comments.createThread(input)
        await revalidate()
        return thread
      },
      [revalidate]
    ),
    reply: useCallback(
      async (input) => {
        const comment = await api.comments.reply(input)
        await revalidate()
        return comment
      },
      [revalidate]
    ),
    edit: useCallback(
      async (id, body) => {
        const comment = await api.comments.update({ id, body })
        await revalidate()
        return comment
      },
      [revalidate]
    ),
    remove: useCallback(
      async (id) => {
        await api.comments.remove({ id })
        await revalidate()
      },
      [revalidate]
    ),
    setResolved: useCallback(
      async (threadId, resolved) => {
        await api.comments.setResolved({ threadId, resolved })
        await revalidate()
      },
      [revalidate]
    )
  }
}
