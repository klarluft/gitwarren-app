/**
 * Add / edit a host.
 *
 * One component for both, like `repository-form-dialog.tsx`, and validated with
 * the same schemas the service re-parses on the other side - so nothing can be
 * accepted here that the service would reject.
 *
 * ## Three fields, and one of them is usually left alone
 *
 * The target is the whole of the interaction. It is handed to `ssh` verbatim,
 * which means every `~/.ssh/config` alias someone already has works, and it
 * carries the user because spike S1 found that a bare MagicDNS name asks for
 * the *client's* username and gets refused by the tailnet policy. Hence the
 * placeholder: `xfor@pc-wsl`, not `pc-wsl`.
 *
 * There is no "test connection" button on the form. Adding a host that cannot
 * be reached is a perfectly ordinary thing to do — the machine is asleep, or
 * the tailnet is not up yet — and a form that refused would be wrong about a
 * situation it cannot see. The row lands in the list and says "Not tried yet",
 * with "Try now" beside it.
 */
import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { errorMessage, firstFieldError } from '@/lib/errors'
import { useHostMutations } from './use-hosts'
import { addHostInputSchema, updateHostInputSchema } from '@shared/schemas'
import { parseWithSchema } from '@shared/validation'
import type { Host } from '@shared/schemas'

interface HostFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when adding. */
  host?: Host | undefined
}

export function HostFormDialog({ open, onOpenChange, host }: HostFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open, which is what resets the fields between
            openings - fresh mount, fresh `useState`, nothing left over. */}
        {open && (
          <HostForm key={host?.id ?? 'new'} host={host} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function HostForm({ host, onDone }: { host: Host | undefined; onDone: () => void }) {
  const isEditing = host !== undefined
  const { addHost, updateHost } = useHostMutations()

  const [target, setTarget] = useState(host?.target ?? '')
  const [label, setLabel] = useState(host?.label ?? '')
  const [editorTarget, setEditorTarget] = useState(host?.editorTarget ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      if (host) {
        const input = parseWithSchema(updateHostInputSchema, {
          id: host.id,
          label: label.trim(),
          ...(target.trim() !== host.target ? { target: target.trim() } : {}),
          // Null rather than omitted when it has been cleared: null is how the
          // schema spells "go back to deriving it from the target", and
          // omitting it would leave the old value in place.
          editorTarget: editorTarget.trim() || null
        })
        await updateHost(input)
      } else {
        const trimmedLabel = label.trim()
        const trimmedEditor = editorTarget.trim()
        const input = parseWithSchema(addHostInputSchema, {
          target: target.trim(),
          // Omitted rather than empty, so the service applies its own default -
          // the target with any `user@` taken off.
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          ...(trimmedEditor ? { editorTarget: trimmedEditor } : {})
        })
        await addHost(input)
      }
      onDone()
    } catch (caught) {
      setError(caught)
    } finally {
      setSubmitting(false)
    }
  }

  const targetError = firstFieldError(error, 'target')
  const labelError = firstFieldError(error, 'label')
  const generalError = error && !targetError && !labelError ? errorMessage(error) : null

  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit host' : 'Add host'}</DialogTitle>
        <DialogDescription>
          {isEditing
            ? 'Rename this machine, or point it somewhere else if the address changed.'
            : 'Anything your own ssh can reach: a config alias, a tailnet name, user@address. ' +
              'GitWarren never asks for a password — your SSH agent and config do the ' +
              'authenticating.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="host-target">SSH host</FieldLabel>
          <Input
            id="host-target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="user@machine"
            className="font-mono text-xs"
            data-invalid={targetError ? '' : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldError>{targetError}</FieldError>
          {!targetError && (
            <FieldDescription>
              Include the user name: a bare tailnet name asks for your local one.
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="host-label">Display name</FieldLabel>
          <Input
            id="host-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={
              target.includes('@') ? target.slice(target.indexOf('@') + 1) : 'Defaults to the host'
            }
            data-invalid={labelError ? '' : undefined}
            autoComplete="off"
          />
          <FieldError>{labelError}</FieldError>
          {!labelError && !isEditing && (
            <FieldDescription>Leave blank to use the machine name.</FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="host-editor-target">Editor host</FieldLabel>
          <Input
            id="host-editor-target"
            value={editorTarget}
            onChange={(event) => setEditorTarget(event.target.value)}
            placeholder={target.trim() || 'Same as the SSH host'}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            Only if your editor knows this machine by a different name. Blank means the SSH host
            above.
          </FieldDescription>
        </Field>

        {generalError && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {generalError}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          {isEditing ? 'Save changes' : 'Add host'}
        </Button>
      </DialogFooter>
    </form>
  )
}
