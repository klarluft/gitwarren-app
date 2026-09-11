/**
 * Add / edit a host.
 *
 * One component for both, like `repository-form-dialog.tsx`, and validated with
 * the same schemas the service re-parses on the other side - so nothing can be
 * accepted here that the service would reject.
 *
 * ## Two carriers, and only one of them has anything to type
 *
 * M5 gave this form a choice, and the two halves of it are deliberately not
 * symmetrical. An `ssh` target is free text, because every `~/.ssh/config` alias
 * somebody already has has to work and no validator can know what those are. A
 * WSL distribution is a *list*: this machine knows exactly which ones exist, and
 * `wsl.exe` matches a name case-insensitively while the unique index does not -
 * so `ubuntu` typed by hand and `Ubuntu` from the list would be two rows for one
 * machine, caught only later by the instance id. Offering the machine's own
 * spelling removes the question.
 *
 * The choice appears only when there is something to choose. `hosts.distros`
 * answers empty on a Mac, on Linux, and on a Windows box with no WSL, and an
 * empty answer means this is the SSH form with no tabs on it - which is what it
 * was before M5, for everyone it was already right for. Nothing here asks what
 * platform it is on: the question is about the machine the *core* runs on, and
 * asking it is the only way a browser tab gets the right answer.
 *
 * ## There is no "test connection" button
 *
 * Adding a host that cannot be reached is a perfectly ordinary thing to do - the
 * machine is asleep, the tailnet is not up yet, the distribution has never been
 * started - and a form that refused would be wrong about a situation it cannot
 * see. The row lands in the list and says "Not tried yet", with "Try now" beside
 * it.
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
import { cn } from '@/lib/utils'
import { useHostMutations, useWslDistros } from './use-hosts'
import { addHostInputSchema, updateHostInputSchema } from '@shared/schemas'
import { parseWithSchema } from '@shared/validation'
import type { Host, WslDistro } from '@shared/schemas'

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
  // Only asked while adding. Editing cannot change a carrier, so the list would
  // be a request nobody reads.
  const { distros, isLoading: loadingDistros } = useWslDistros(!isEditing)

  const [kind, setKind] = useState<'ssh' | 'wsl'>(host?.kind ?? 'ssh')
  const [target, setTarget] = useState(host?.target ?? '')
  const [label, setLabel] = useState(host?.label ?? '')
  const [editorTarget, setEditorTarget] = useState(host?.editorTarget ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const canAddWsl = !isEditing && distros !== undefined && distros.length > 0

  function chooseKind(next: 'ssh' | 'wsl'): void {
    if (next === kind) return
    setKind(next)
    // The two targets are different kinds of string and share no spelling, so
    // carrying one across would leave an ssh destination in a distro field and
    // a validation error nobody caused.
    setTarget('')
    setError(null)
  }

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
          kind,
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

  const isWsl = kind === 'wsl'
  // A WSL host is identified by its distribution, so the target is not something
  // an edit may change - the service refuses it, and a field that could produce
  // only an error is not a field worth drawing.
  const showTargetField = !(isEditing && host.kind === 'wsl')

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
            : isWsl
              ? 'A Linux distribution running on this PC. GitWarren talks to it through ' +
                'wsl.exe — nothing to configure, and nothing listening on a port.'
              : 'Anything your own ssh can reach: a config alias, a tailnet name, user@address. ' +
                'GitWarren never asks for a password — your SSH agent and config do the ' +
                'authenticating.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        {canAddWsl && (
          <Field>
            <FieldLabel>Connect by</FieldLabel>
            <div className="flex gap-2">
              <CarrierChoice
                selected={kind === 'ssh'}
                label="SSH"
                onSelect={() => chooseKind('ssh')}
              />
              <CarrierChoice
                selected={isWsl}
                label="WSL"
                onSelect={() => chooseKind('wsl')}
              />
            </div>
          </Field>
        )}

        {showTargetField &&
          (isWsl ? (
            <Field>
              <FieldLabel htmlFor="host-distro">Distribution</FieldLabel>
              <DistroPicker
                distros={distros ?? []}
                loading={loadingDistros}
                selected={target}
                onSelect={setTarget}
              />
              <FieldError>{targetError}</FieldError>
              {!targetError && (
                <FieldDescription>
                  GitWarren runs as that distribution&apos;s own default user.
                </FieldDescription>
              )}
            </Field>
          ) : (
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
          ))}

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
            <FieldDescription>
              Leave blank to use the {isWsl ? 'distribution' : 'machine'} name.
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="host-editor-target">Editor host</FieldLabel>
          <Input
            id="host-editor-target"
            value={editorTarget}
            onChange={(event) => setEditorTarget(event.target.value)}
            placeholder={
              isWsl
                ? target.trim()
                  ? `wsl+${target.trim()}`
                  : 'wsl+<distribution>'
                : target.trim() || 'Same as the SSH host'
            }
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>
            Only if your editor knows this machine by a different name. Blank means the{' '}
            {isWsl ? 'distribution above' : 'SSH host above'}.
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

function CarrierChoice({
  selected,
  label,
  onSelect
}: {
  selected: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <Button
      type="button"
      variant={selected ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={selected}
      onClick={onSelect}
    >
      {label}
    </Button>
  )
}

/**
 * The distributions, as rows rather than as a `<select>`.
 *
 * A row can carry what a select option cannot: that one of them is already in
 * the host list, which is the single most likely reason somebody is about to
 * get an error. Those are disabled and say so, rather than being dropped -
 * dropping them would make the list disagree with the one `wsl.exe` prints, and
 * "why is Ubuntu not here" is a worse question than "why can I not pick it".
 *
 * Nothing is filtered, including the `docker-desktop` distributions this
 * machine has. See `listDistros` in `core/hosts/wsl.ts` for why a blocklist of
 * names was refused.
 */
function DistroPicker({
  distros,
  loading,
  selected,
  onSelect
}: {
  distros: WslDistro[]
  loading: boolean
  selected: string
  onSelect: (name: string) => void
}) {
  if (loading) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-3 animate-spin" /> Looking for distributions…
      </p>
    )
  }
  if (distros.length === 0) {
    return <p className="text-muted-foreground text-sm">This machine has no WSL distributions.</p>
  }

  return (
    <div id="host-distro" className="flex flex-col gap-1">
      {distros.map((distro) => (
        <button
          key={distro.name}
          type="button"
          disabled={distro.alreadyAdded}
          aria-pressed={selected === distro.name}
          onClick={() => onSelect(distro.name)}
          className={cn(
            'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm',
            selected === distro.name ? 'border-primary bg-primary/5' : 'border-border',
            distro.alreadyAdded && 'cursor-not-allowed opacity-50'
          )}
        >
          <span className="font-mono text-xs">{distro.name}</span>
          <span className="text-muted-foreground text-xs">
            {distro.alreadyAdded
              ? 'already added'
              : [distro.isDefault ? 'default' : null, distro.running ? 'running' : 'stopped']
                  .filter(Boolean)
                  .join(' · ')}
          </span>
        </button>
      ))}
    </div>
  )
}
