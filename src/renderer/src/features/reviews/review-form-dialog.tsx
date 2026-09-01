/**
 * Create / edit form for a review.
 *
 * One component for both, following `repository-form-dialog`: the form body is
 * mounted only while the dialog is open, so it resets between openings without
 * an effect writing state back.
 *
 * The endpoints default to "the trunk, and whatever you are working on" -
 * `defaultBranch` into `currentBranch` - which is the review the user almost
 * always wants and saves them two menu visits.
 */
import { useState, type FormEvent } from 'react'
import { ArrowRight, CircleDot, Loader2 } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage, firstFieldError } from '@/lib/errors'
import { RefSelect } from './ref-select'
import { useRepositoryRefs, useReviewMutations } from './use-reviews'
import { createReviewInputSchema, updateReviewInputSchema } from '@shared/schemas'
import { parseWithSchema } from '@shared/validation'
import type { GitRef } from '@shared/git'
import type { Review } from '@shared/schemas'

interface ReviewFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repositoryId: number
  /** Present when editing; absent when creating. */
  review?: Review | undefined
  onCreated?: (review: Review) => void
}

export function ReviewFormDialog({
  open,
  onOpenChange,
  repositoryId,
  review,
  onCreated
}: ReviewFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {open && (
          <ReviewForm
            key={review?.id ?? 'new'}
            repositoryId={repositoryId}
            review={review}
            onDone={() => onOpenChange(false)}
            {...(onCreated ? { onCreated } : {})}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface ReviewFormProps {
  repositoryId: number
  review: Review | undefined
  onDone: () => void
  onCreated?: (review: Review) => void
}

function ReviewForm({ repositoryId, review, onDone, onCreated }: ReviewFormProps) {
  const isEditing = review !== undefined
  const { createReview, updateReview } = useReviewMutations()
  const { data: refs, isLoading: refsLoading, error: refsError } = useRepositoryRefs(repositoryId)

  // `undefined` means "not touched yet", so the defaults below can arrive with
  // the refs without an effect overwriting something the user already picked.
  const [baseRef, setBaseRef] = useState<string | undefined>(review?.baseRef)
  const [headRef, setHeadRef] = useState<string | undefined>(review?.headRef)
  const [title, setTitle] = useState(review?.title ?? '')
  const [description, setDescription] = useState(review?.description ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const base = baseRef ?? refs?.defaultBranch ?? ''
  const head =
    headRef ??
    // Don't default head to the same ref as base - that review is empty by
    // definition, and the form would open already invalid.
    (refs?.currentBranch && refs.currentBranch !== (refs.defaultBranch ?? '')
      ? refs.currentBranch
      : '')

  const availableRefs: GitRef[] = refs?.refs ?? []
  const headDetails = availableRefs.find((ref) => ref.name === head)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const trimmedTitle = title.trim()
      if (review) {
        const input = parseWithSchema(updateReviewInputSchema, {
          id: review.id,
          ...(trimmedTitle && trimmedTitle !== review.title ? { title: trimmedTitle } : {}),
          ...(description !== review.description ? { description } : {}),
          ...(base !== review.baseRef ? { baseRef: base } : {}),
          ...(head !== review.headRef ? { headRef: head } : {})
        })
        await updateReview(input)
      } else {
        const input = parseWithSchema(createReviewInputSchema, {
          repositoryId,
          baseRef: base,
          headRef: head,
          // Omitted rather than blank, so the service applies its own default.
          ...(trimmedTitle ? { title: trimmedTitle } : {}),
          ...(description ? { description } : {})
        })
        const created = await createReview(input)
        onCreated?.(created)
      }
      onDone()
    } catch (caught) {
      setError(caught)
    } finally {
      setSubmitting(false)
    }
  }

  const baseError = firstFieldError(error, 'baseRef')
  const headError = firstFieldError(error, 'headRef')
  const titleError = firstFieldError(error, 'title')
  const generalError = error && !baseError && !headError && !titleError ? errorMessage(error) : null

  const nothingChanged =
    isEditing &&
    title.trim() === review.title &&
    description === review.description &&
    base === review.baseRef &&
    head === review.headRef

  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit review' : 'New review'}</DialogTitle>
        <DialogDescription>
          Changes are compared from where the two refs diverged, the way a pull request is.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        {refsLoading && (
          <div className="flex items-end gap-2">
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="mb-2 size-4" />
            <Skeleton className="h-9 flex-1" />
          </div>
        )}

        {!refsLoading && refsError !== undefined && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errorMessage(refsError)}
          </p>
        )}

        {!refsLoading && refsError === undefined && (
          <>
            <div className="flex items-end gap-2">
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="review-base">Base</FieldLabel>
                <RefSelect
                  id="review-base"
                  refs={availableRefs}
                  value={base}
                  onChange={setBaseRef}
                  invalid={baseError !== undefined}
                />
              </Field>

              <ArrowRight className="mb-2.5 size-4 shrink-0 text-muted-foreground" />

              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="review-head">Compare</FieldLabel>
                <RefSelect
                  id="review-head"
                  refs={availableRefs}
                  value={head}
                  onChange={setHeadRef}
                  invalid={headError !== undefined}
                />
              </Field>
            </div>

            {(baseError ?? headError) !== undefined && (
              <FieldError>{baseError ?? headError}</FieldError>
            )}

            {headDetails?.hasUncommittedChanges && (
              <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
                <CircleDot className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-mono">{headDetails.name}</span> has uncommitted changes in{' '}
                  <span data-selectable className="font-mono">
                    {headDetails.checkedOutAt}
                  </span>
                  . They will be part of this review.
                </span>
              </p>
            )}

            <Field>
              <FieldLabel htmlFor="review-title">Title</FieldLabel>
              <Input
                id="review-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={base && head ? `${head} into ${base}` : 'Describe the change'}
                data-invalid={titleError ? '' : undefined}
                autoComplete="off"
              />
              <FieldError>{titleError}</FieldError>
              {!titleError && !isEditing && (
                <FieldDescription>Leave blank to name it after the two refs.</FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="review-description">Description</FieldLabel>
              <Textarea
                id="review-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What should a reviewer know before reading the diff?"
                rows={4}
              />
              <FieldDescription>Optional. Shown at the top of the conversation.</FieldDescription>
            </Field>
          </>
        )}

        {generalError && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {generalError}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || refsLoading || !base || !head || nothingChanged}>
          {submitting && <Loader2 className="animate-spin" />}
          {isEditing ? 'Save changes' : 'Create review'}
        </Button>
      </DialogFooter>
    </form>
  )
}
