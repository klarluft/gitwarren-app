/**
 * Add / edit form.
 *
 * One component for both because the rules are the same either way - the only
 * difference is which schema is used and which mutation is called. Validation
 * uses the schemas from `@shared/schemas`, the same objects the service and the
 * MCP tools use, so nothing can be accepted here that the service would reject
 * (or vice versa).
 *
 * The form body is a separate component mounted only while the dialog is open.
 * That is what resets it between openings: fresh mount, fresh `useState`, no
 * effect writing state back on open and no values left over from a previous
 * attempt.
 *
 * ## Which machine the folder is on
 *
 * There is no host picker on this form, and there was very nearly one. The
 * reason there is not is that the form is already *on* a machine: it is opened
 * from a repository list, and a repository list belongs to exactly one install.
 * Adding a host dropdown here would be a second way to say the same thing, and
 * two ways to say it means they can disagree - a form set to `pc-wsl` sitting
 * on this Mac's list, submitting a row that then does not appear above it. The
 * way to add a repository on `pc-wsl` is to be looking at `pc-wsl`, which is
 * one click from the Hosts screen and is also where the result shows up.
 *
 * What that leaves is the folder, and browsing for it is the part that had to
 * be built: `api.system.pickDirectory` opens a window on the machine the person
 * is sitting at, which is the wrong machine whenever this form is on a host.
 * So the native picker is used in exactly one case - a local form in the
 * Electron window - and `DirectoryBrowserDialog` covers the other two, a
 * browser tab and any host. See the note at the top of that file.
 */
import { useState, type FormEvent } from 'react'
import { FolderOpen, FolderSearch, Loader2 } from 'lucide-react'
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
import { api } from '@/lib/api'
import { errorCode, errorMessage, firstFieldError } from '@/lib/errors'
import { useHost } from '@/lib/host-scope'
import { basename } from '@/lib/path'
import { DirectoryBrowserDialog } from './directory-browser-dialog'
import { useRepositoryMutations } from './use-repositories'
import { addRepositoryInputSchema, updateRepositoryInputSchema } from '@shared/schemas'
import { parseWithSchema } from '@shared/validation'
import type { Repository } from '@shared/schemas'

interface RepositoryFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when adding. */
  repository?: Repository | undefined
}

export function RepositoryFormDialog({
  open,
  onOpenChange,
  repository
}: RepositoryFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && (
          <RepositoryForm
            key={repository?.id ?? 'new'}
            repository={repository}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface RepositoryFormProps {
  repository: Repository | undefined
  onDone: () => void
}

function RepositoryForm({ repository, onDone }: RepositoryFormProps) {
  const isEditing = repository !== undefined
  const host = useHost()
  const { addRepository, updateRepository } = useRepositoryMutations()

  const [path, setPath] = useState(repository?.path ?? '')
  const [name, setName] = useState(repository?.name ?? '')
  const [browsing, setBrowsing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // The native dialog only where it would open on the right machine. See the
  // note at the top of the file.
  const nativePicker = api.capabilities.pickDirectory && host === undefined

  async function browseNatively(): Promise<void> {
    const picked = await api.system.pickDirectory()
    if (!picked) return
    setPath(picked)
    setError(null)
  }

  function chose(picked: string): void {
    setPath(picked)
    setError(null)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      if (repository) {
        const input = parseWithSchema(updateRepositoryInputSchema, {
          id: repository.id,
          name: name.trim(),
          // Only send a path when it actually changed; re-sending the same one
          // would make the service re-resolve it for no reason.
          ...(path.trim() !== repository.path ? { path: path.trim() } : {})
        })
        await updateRepository(input)
      } else {
        const trimmedName = name.trim()
        const input = parseWithSchema(addRepositoryInputSchema, {
          path: path.trim(),
          // Omitted rather than empty, so the service applies the folder-name
          // default instead of receiving a blank string.
          ...(trimmedName ? { name: trimmedName } : {})
        })
        await addRepository(input)
      }
      onDone()
    } catch (caught) {
      setError(caught)
    } finally {
      setSubmitting(false)
    }
  }

  const pathError = firstFieldError(error, 'path')
  const nameError = firstFieldError(error, 'name')
  // A message with no field of its own still needs somewhere to appear.
  const generalError = error && !pathError && !nameError ? errorMessage(error) : null
  const derivedName = basename(path.trim())

  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit repository' : 'Add repository'}</DialogTitle>
        <DialogDescription>
          {isEditing
            ? 'Rename this repository, or point it at a new location if you moved it.'
            : host === undefined
              ? 'Choose any folder inside a git repository. GitWarren stores the repository root.'
              : // Said plainly, because the path about to be typed is a path on
                // a machine that is not the one under the keyboard.
                'Choose a folder on that machine. GitWarren stores the repository root.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="repository-path">Repository folder</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="repository-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/path/to/repository"
              className="font-mono text-xs"
              data-invalid={pathError ? '' : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {/* Two buttons that do the same job on two different machines, and
                never both: the shell's own dialog when the folder is on the
                machine with the window, and a listing read over the carrier
                otherwise - a browser tab, or any host. */}
            {nativePicker ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void browseNatively()}
                className="shrink-0"
              >
                <FolderOpen />
                Browse
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => setBrowsing(true)}
                className="shrink-0"
              >
                <FolderSearch />
                Browse
              </Button>
            )}
          </div>
          <FieldError>{pathError}</FieldError>
          {!pathError && (
            <FieldDescription>
              A subfolder works too - it resolves to the repository root.
            </FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="repository-name">Display name</FieldLabel>
          <Input
            id="repository-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={derivedName || 'Defaults to the folder name'}
            data-invalid={nameError ? '' : undefined}
            autoComplete="off"
          />
          <FieldError>{nameError}</FieldError>
          {!nameError && !isEditing && (
            <FieldDescription>Leave blank to use the folder name.</FieldDescription>
          )}
        </Field>

        {generalError && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {generalError}
            {errorCode(error) === 'GIT_UNAVAILABLE' && (
              <span className="mt-1 block text-xs opacity-80">
                GitWarren shells out to your own git installation.
              </span>
            )}
          </p>
        )}
      </div>

      <DirectoryBrowserDialog
        open={browsing}
        onOpenChange={setBrowsing}
        initialPath={path.trim() === '' ? undefined : path.trim()}
        onChoose={chose}
      />

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          {isEditing ? 'Save changes' : 'Add repository'}
        </Button>
      </DialogFooter>
    </form>
  )
}
