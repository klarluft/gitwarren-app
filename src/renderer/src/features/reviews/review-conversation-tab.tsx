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
 * the app makes without being asked. It is deliberate: the snippet has to come
 * from the diff that is actually on the branch now, since a comment's line moves
 * as the branch does - the alternative, storing the surrounding lines when the
 * comment was written, would show code that has since been rewritten. The read
 * shares its cache key with the Files changed tab, so visiting both costs one
 * diff. When it is slow, or the line has left the diff entirely, the thread
 * still renders - against the single line captured when the comment was
 * written, or against nothing at all.
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
import {
  findAnchorFile,
  isInlineAnchor,
  resolveAnchor,
  type AnchorState,
  type DiffSide
} from '@shared/comment-anchors'
import { snippetAt, type AnchorSnippet } from '@shared/comment-snippets'
import type { DiffLine, FileDiff } from '@shared/git'
import type { CommentThread, Review } from '@shared/schemas'

interface ReviewConversationTabProps {
  review: Review
  onEdit: () => void
}

/** What to print above a line thread. Null for a review-level thread. */
interface ThreadSnippet {
  filePath: string
  side: DiffSide
  line: number | null
  state: AnchorState
  lines: DiffLine[]
  clipped: boolean
}

interface TimelineEntry {
  thread: CommentThread
  snippet: ThreadSnippet | null
}

/**
 * The line captured when the comment was written - all that is left to show
 * once the diff has moved on past it.
 */
function storedLine(thread: CommentThread, side: DiffSide): AnchorSnippet | null {
  if (thread.anchorText === null) return null
  return {
    lines: [
      {
        type: 'context',
        content: thread.anchorText,
        oldNumber: side === 'base' ? thread.line : null,
        newNumber: side === 'head' ? thread.line : null
      }
    ],
    clipped: false
  }
}

/**
 * Put every thread on one timeline, oldest first, with its code attached.
 *
 * Line threads are re-anchored against the diff on screen rather than trusted
 * to their stored line number - the same `resolveAnchor` the Files changed tab
 * and the MCP server run, so no two surfaces disagree about where a comment
 * sits.
 */
function buildTimeline(threads: CommentThread[], files: FileDiff[] | undefined): TimelineEntry[] {
  const entries = threads.map<TimelineEntry>((thread) => {
    if (!isInlineAnchor(thread)) return { thread, snippet: null }

    const file = files === undefined ? undefined : findAnchorFile(files, thread.filePath)
    const anchor = resolveAnchor(file, {
      filePath: thread.filePath,
      side: thread.side,
      line: thread.line,
      anchorText: thread.anchorText
    })

    const snippet =
      (anchor.line === null ? null : snippetAt(file, thread.side, anchor.line)) ??
      storedLine(thread, thread.side)

    return {
      thread,
      snippet: {
        // Under its current name, so a comment left before a rename is filed
        // against the file the reviewer is looking at now.
        filePath: file?.path ?? thread.filePath,
        side: thread.side,
        line: anchor.line ?? thread.line,
        // While the diff is still loading there is nothing to anchor against,
        // and calling that "outdated" would be a claim the app cannot support.
        state: files === undefined ? 'anchored' : anchor.state,
        lines: snippet?.lines ?? [],
        clipped: snippet?.clipped ?? false
      }
    }
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
