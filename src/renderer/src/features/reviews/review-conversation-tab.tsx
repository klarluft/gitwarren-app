/**
 * The conversation tab: the review's description as the opening post, then the
 * discussion.
 *
 * Both kinds of thread land here, in the order they were written. A review-level
 * thread is prose and stands on its own; a line thread is answered by a snippet
 * of the code it is about, printed above it the way GitHub prints a hunk above a
 * review comment - "this should be awaited" is close to meaningless without the
 * line it points at, and sending the reader to another tab to find it is how a
 * review conversation stops being readable.
 *
 * That snippet means this tab reads the diff, which is the one git-backed read
 * the app makes without being asked. It is deliberate: while a comment still
 * points at live code, the reader should see that code as it is now, not as it
 * was. It shares its cache key with the Files changed tab, so visiting both
 * costs one diff. When the code has moved on past the comment, the snapshot
 * stored when the comment was written is shown instead - see `comment-snippets`.
 */
import { useMemo } from 'react'
import { MessageSquare, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { absoluteTime, relativeTime } from '@/lib/format'
import { replace } from '@/lib/router'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { useCommentMutations, useReviewComments } from '../comments/use-comments'
import { DiffSnippet } from './diff-snippet'
import { useReviewDiff } from './use-reviews'
import { findAnchorFile, isInlineAnchor, resolveAnchor } from '@shared/comment-anchors'
import { threadSnippet, type ThreadSnippet } from '@shared/comment-snippets'
import type { FileDiff } from '@shared/git'
import type { CommentThread, Review } from '@shared/schemas'

interface ReviewConversationTabProps {
  review: Review
  onEdit: () => void
}

interface TimelineEntry {
  thread: CommentThread
  /** What to print above it. Null for a review-level thread. */
  snippet: ThreadSnippet | null
}

/**
 * Put every thread on one timeline, oldest first, with its code attached.
 *
 * Line threads are re-anchored against the diff on screen rather than trusted
 * to their stored line number - the same `resolveAnchor` the Files changed tab
 * and the MCP server run, so no two surfaces disagree about where a comment
 * sits. `files` is undefined while that diff is still being read.
 */
function buildTimeline(threads: CommentThread[], files: FileDiff[] | undefined): TimelineEntry[] {
  const entries = threads.map<TimelineEntry>((thread) => {
    if (!isInlineAnchor(thread)) return { thread, snippet: null }

    const file = files === undefined ? undefined : findAnchorFile(files, thread.filePath)
    const anchor =
      files === undefined
        ? null
        : resolveAnchor(file, {
            filePath: thread.filePath,
            side: thread.side,
            line: thread.line,
            anchorText: thread.anchorText
          })

    return { thread, snippet: threadSnippet(thread, anchor, file) }
  })

  return entries.sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt))
}

export function ReviewConversationTab({ review, onEdit }: ReviewConversationTabProps) {
  const { threads, error, isLoading } = useReviewComments(review.id)
  const mutations = useCommentMutations(review.id)

  // Matches the Files changed tab's default, so the two share one cached diff.
  const { data: diff, isLoading: diffLoading } = useReviewDiff(review.id, true)

  const timeline = useMemo(() => buildTimeline(threads, diff?.files), [threads, diff?.files])

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Opened{' '}
            <span title={absoluteTime(review.createdAt)}>{relativeTime(review.createdAt)}</span>
          </p>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil />
            Edit
          </Button>
        </div>

        {review.description ? (
          <p data-selectable className="whitespace-pre-wrap text-sm leading-relaxed">
            {review.description}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground">No description.</p>
        )}
      </Card>

      {isLoading && <Skeleton className="h-24 w-full" />}

      {error !== undefined && error !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}

      {timeline.map(({ thread, snippet }) => (
        <div key={thread.id} className="flex flex-col gap-2">
          {snippet !== null &&
            // A thread with neither a snapshot nor a live anchor has nothing to
            // show until the diff arrives; anything else renders immediately.
            (snippet.lines.length === 0 && diffLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <DiffSnippet
                {...snippet}
                // A resolved thread is settled; its code should not shout as
                // loudly as code still being argued about.
                className={thread.resolvedAt !== null ? 'opacity-60' : undefined}
                onOpen={() => replace({ name: 'review', reviewId: review.id, tab: 'files' })}
              />
            ))}
          <CommentThreadCard thread={thread} mutations={mutations} />
        </div>
      ))}

      {!isLoading && timeline.length === 0 && (
        <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
          <div className="rounded-full bg-muted p-3 text-muted-foreground">
            <MessageSquare className="size-6" />
          </div>
          <h3 className="font-medium">No comments yet</h3>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Start the discussion below, or comment on a line in Files changed. Agents connected over
            MCP write into the same threads.
          </p>
        </Card>
      )}

      <Card className="p-3">
        <CommentComposer
          placeholder="Leave a comment on this review"
          onSubmit={(body) => mutations.createThread({ reviewId: review.id, body })}
        />
      </Card>
    </div>
  )
}
