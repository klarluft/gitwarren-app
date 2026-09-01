/**
 * The conversation tab.
 *
 * Deliberately unfinished: comments are the next piece of work, and this tab is
 * where they will land. What it does today is show the review's description as
 * the opening post, so the tab has real content and the eventual thread has an
 * obvious place to start.
 */
import { MessageSquare, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { absoluteTime, relativeTime } from '@/lib/format'
import type { Review } from '@shared/schemas'

interface ReviewConversationTabProps {
  review: Review
  onEdit: () => void
}

export function ReviewConversationTab({ review, onEdit }: ReviewConversationTabProps) {
  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Opened <span title={absoluteTime(review.createdAt)}>{relativeTime(review.createdAt)}</span>
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

      <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <MessageSquare className="size-6" />
        </div>
        <h3 className="font-medium">Comments are coming</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          This is where the discussion of the change will live — including comments left by local
          agents through the MCP server.
        </p>
      </Card>
    </div>
  )
}
