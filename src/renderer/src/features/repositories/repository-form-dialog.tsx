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
 */
import { useState, type FormEvent } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
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
import { basename } from '@/lib/path'
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
  const { addRepository, updateRepository } = useRepositoryMutations()

  const [path, setPath] = useState(repository?.path ?? '')
  const [name, setName] = useState(repository?.name ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function browse(): Promise<void> {
    const picked = await api.system.pickDirectory()
    if (!picked) return
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
            : 'Choose any folder inside a git repository. GitWarren stores the repository root.'}
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
            <Button
              type="button"
              variant="outline"
              onClick={() => void browse()}
              className="shrink-0"
            >
              <FolderOpen />
              Browse
            </Button>
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
