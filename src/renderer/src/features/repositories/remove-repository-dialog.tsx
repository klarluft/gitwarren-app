/**
 * Removal confirmation.
 *
 * Worth being explicit that this only stops tracking - people reasonably fear
 * that a "remove" in a git tool might delete their working copy.
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
import { useRepositoryMutations } from './use-repositories'
import type { Repository } from '@shared/schemas'

interface RemoveRepositoryDialogProps {
  repository: Repository | null
  onOpenChange: (open: boolean) => void
}

export function RemoveRepositoryDialog({
  repository,
  onOpenChange
}: RemoveRepositoryDialogProps) {
  const { removeRepository } = useRepositoryMutations()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function confirm(): Promise<void> {
    if (!repository) return
    setSubmitting(true)
    setError(null)
    try {
      await removeRepository(repository.id)
      onOpenChange(false)
    } catch (caught) {
      setError(caught)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog
      open={repository !== null}
      onOpenChange={(open) => {
        if (!open) setError(null)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove &ldquo;{repository?.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the repository from GitWarren only. Nothing on disk is deleted and the
            working copy is left exactly as it is.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {repository && (
          <p
            data-selectable
            className="mt-3 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground"
            title={repository.path}
          >
            {repository.path}
          </p>
        )}

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
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
