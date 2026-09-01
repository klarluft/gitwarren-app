/**
 * The conversation tab: the review's description as the opening post, then the
 * discussion.
 *
 * Two kinds of thread land here and they are kept apart on purpose. Review-level
 * threads are the conversation proper and get the composer at the bottom. Line
 * threads live in the Files changed tab, where the code they are about is - but
 * they are *summarised* here, because a reviewer who opens a review wants to
 * know there are four unresolved comments waiting without hunting for them in
 * the diff. The summary links across rather than duplicating the discussion.
 */
import { useMemo } from 'react'
import { FileCode, MessageSquare, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { absoluteTime, plural, relativeTime } from '@/lib/format'
import { replace } from '@/lib/router'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { useCommentMutations, useReviewComments } from '../comments/use-comments'
import { isInlineAnchor } from '@shared/comment-anchors'
import type { Review } from '@shared/schemas'

interface ReviewConversationTabProps {
  review: Review
  onEdit: () => void
}

export function ReviewConversationTab({ review, onEdit }: ReviewConversationTabProps) {
  const { threads, error, isLoading } = useReviewComments(review.id)
  const mutations = useCommentMutations(review.id)

  const { discussion, inline } = useMemo(
    () => ({
      discussion: threads.filter((thread) => !isInlineAnchor(thread)),
      inline: threads.filter((thread) => isInlineAnchor(thread))
    }),
    [threads]
  )

  const unresolvedInline = inline.filter((thread) => thread.resolvedAt === null)

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

      {inline.length > 0 && (
        <button
          type="button"
          onClick={() => replace({ name: 'review', reviewId: review.id, tab: 'files' })}
          className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/60"
        >
          <FileCode className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm">
            {plural(inline.length, 'comment')} on the code
            {unresolvedInline.length > 0 && (
              <span className="text-muted-foreground">
                {' '}
                · {unresolvedInline.length} unresolved
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">Files changed →</span>
        </button>
      )}

      {isLoading && <Skeleton className="h-24 w-full" />}

      {error !== undefined && error !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}

      {discussion.map((thread) => (
        <CommentThreadCard key={thread.id} thread={thread} mutations={mutations} />
      ))}

      {!isLoading && discussion.length === 0 && inline.length === 0 && (
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
