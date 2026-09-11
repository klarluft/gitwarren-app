/**
 * Removal confirmation.
 *
 * The sentence matters more here than it does for a repository. "Remove" on a
 * machine somebody has just installed software onto reads as "uninstall it",
 * and it is not: this forgets a row on *this* GitWarren, and everything under
 * `~/.gitwarren` over there is left exactly where it is. Saying so also happens
 * to be the honest description of what M4.2 shipped - see the note at the top
 * of `core/hosts/install.ts` on why there is no remote uninstall.
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
import { Breakable } from '@/components/breakable'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { useHostMutations } from './use-hosts'
import type { Host } from '@shared/schemas'

interface RemoveHostDialogProps {
  host: Host | null
  onOpenChange: (open: boolean) => void
}

export function RemoveHostDialog({ host, onOpenChange }: RemoveHostDialogProps) {
  const { removeHost } = useHostMutations()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function confirm(): Promise<void> {
    if (!host) return
    setSubmitting(true)
    setError(null)
    try {
      await removeHost(host.id)
      onOpenChange(false)
    } catch (caught) {
      setError(caught)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog
      open={host !== null}
      onOpenChange={(open) => {
        if (!open) setError(null)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Forget &ldquo;{host?.label}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the machine from this GitWarren&rsquo;s list. Nothing is uninstalled: the
            daemon under <code>~/.gitwarren</code> over there stays where it is, and an agent
            configured against it keeps working.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {host && (
          <p
            data-selectable
            className="mt-3 break-words rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground"
          >
            <Breakable text={host.target} />
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
            Forget host
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
