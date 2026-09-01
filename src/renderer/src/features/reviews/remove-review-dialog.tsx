/**
 * Deletion confirmation for a review.
 *
 * Points at closing as the alternative, since "I am done with this" is almost
 * always what someone means, and a closed review keeps its history.
 */
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { useReviewMutations } from './use-reviews'
import type { Review } from '@shared/schemas'

interface RemoveReviewDialogProps {
  review: Review | null
  onOpenChange: (open: boolean) => void
  onRemoved?: () => void
}

export function RemoveReviewDialog({ review, onOpenChange, onRemoved }: RemoveReviewDialogProps) {
  const { removeReview } = useReviewMutations()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function confirm(): Promise<void> {
    if (!review) return
    setSubmitting(true)
    setError(null)
    try {
      await removeReview(review.id)
      onOpenChange(false)
      onRemoved?.()
    } catch (caught) {
      setError(caught)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open) setError(null)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{review?.title}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            The review and anything attached to it are removed. No branch, commit or file in the
            repository is touched. If you are simply finished with it, close it instead — a closed
            review is kept.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {errorMessage(error)}
          </p>
        )}

        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            Delete review
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
