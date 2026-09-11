/**
 * What the install did, afterwards.
 *
 * A dialog rather than a toast, and that is a decision about how long the thing
 * takes. An install is tens of seconds on a first run: the person pressed a
 * button, watched a spinner, and quite possibly went to make tea. A message
 * that fades after four seconds is a message they will miss, and the one they
 * will miss most is the failure — which is a paragraph of `ssh`'s own words and
 * the only thing that says what to fix.
 *
 * `already-current` gets the same dialog as the other two on purpose. Pressing
 * a button and having nothing happen is the outcome people report as a bug; the
 * useful answer is "0.1.7-beta.1 is already there", and it costs one sentence.
 */
import { CheckCircle2, XCircle } from 'lucide-react'
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
import type { InstallReport } from '@shared/schemas'

export type InstallOutcome =
  | { kind: 'done'; label: string; report: InstallReport }
  | { kind: 'error'; label: string; message: string }

/** `45.2 MB`. Decimal, because that is what a download is measured in. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function title(outcome: InstallOutcome): string {
  if (outcome.kind === 'error') return `Could not install on “${outcome.label}”`
  switch (outcome.report.action) {
    case 'installed':
      return `GitWarren is on “${outcome.label}”`
    case 'upgraded':
      return `“${outcome.label}” is up to date`
    case 'already-current':
      return `“${outcome.label}” was already up to date`
  }
}

function body(outcome: InstallOutcome): string {
  if (outcome.kind === 'error') return outcome.message

  const { action, version, previousVersion, target, bytes } = outcome.report
  switch (action) {
    case 'installed':
      return (
        `Version ${version} for ${target}, ${megabytes(bytes)} sent over the connection. ` +
        'The launcher at ~/.gitwarren/bin/gitwarren is what everything points at from now on, ' +
        'so an agent configured against it will survive every update.'
      )
    case 'upgraded':
      return (
        `Upgraded from ${previousVersion ?? 'an unknown version'} to ${version} for ${target}, ` +
        `${megabytes(bytes)} sent. The old version is still in ~/.gitwarren/daemon if you need ` +
        'to go back to it.'
      )
    case 'already-current':
      return (
        `${version} is already installed for ${target}, so nothing was sent. Use it anyway if ` +
        'you think the install there is damaged — the button reinstalls when the version matches.'
      )
  }
}

export function InstallResultDialog({
  outcome,
  onClose
}: {
  outcome: InstallOutcome | null
  onClose: () => void
}) {
  const failed = outcome?.kind === 'error'

  return (
    <AlertDialog
      open={outcome !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {failed ? (
              <XCircle className="size-5 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="size-5 shrink-0 text-success" />
            )}
            {outcome && title(outcome)}
          </AlertDialogTitle>
          {/* The failure is `ssh`'s own sentence and can be long and full of
              paths, so it breaks rather than overflows. */}
          <AlertDialogDescription className="break-words">
            {outcome && <Breakable text={body(outcome)} />}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <Button onClick={onClose}>Close</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
