/**
 * Data access for review comments.
 *
 * Unlike the commit and diff reads next door, this one *is* revalidated on
 * focus, and that difference is deliberate. The git reads are expensive and
 * spawn processes, so the app waits to be asked. Comments are a single indexed
 * SQLite query against a database another process is actively writing to -
 * every agent working the review writes through the MCP server - so the cost of
 * checking is nil and the cost of not checking is reading a discussion that
 * moved on while the window was in the background.
 */
import useSWR, { useSWRConfig } from 'swr'
import { useCallback } from 'react'
import { api, CACHE_KEYS, CACHE_PREFIXES } from '@/lib/api'
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
  const { data, error, isLoading, mutate } = useSWR<CommentThread[], unknown>(
    CACHE_KEYS.reviewComments(reviewId),
    () => api.comments.list({ reviewId }),
    {
      // Agents write to the same database from their own processes; a stale
      // thread list is the one thing this screen must not show.
      revalidateOnFocus: true,
      refreshInterval: 15_000
    }
  )

  return { threads: data ?? EMPTY, error, isLoading, refresh: mutate }
}

export interface CommentMutations {
  createThread: (input: CreateThreadInput) => Promise<CommentThread>
  reply: (input: ReplyToThreadInput) => Promise<Comment>
  edit: (id: number, body: string) => Promise<Comment>
  remove: (id: number) => Promise<void>
  setResolved: (threadId: number, resolved: boolean) => Promise<void>
}

export function useCommentMutations(reviewId: number): CommentMutations {
  const { mutate } = useSWRConfig()

  // A comment also bumps its review's `updatedAt`, which reorders every review
  // list, so the whole family is revalidated rather than just this thread list.
  const revalidate = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key === CACHE_KEYS.reviewComments(reviewId) ||
            key.startsWith(CACHE_PREFIXES.reviews) ||
            key.startsWith(CACHE_PREFIXES.review))
      ),
    [mutate, reviewId]
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
