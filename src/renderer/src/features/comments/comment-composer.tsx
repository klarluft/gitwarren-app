/**
 * The box you type a comment into.
 *
 * Submits on Cmd/Ctrl+Enter as well as on the button, because this is a
 * keyboard-driven screen and reaching for the mouse to post a one-line reply is
 * the kind of friction that stops people commenting at all.
 *
 * There is no author picker and there never will be. What the person types is a
 * human comment because they typed it; see `shared/actors.ts`.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'

interface CommentComposerProps {
  placeholder?: string
  submitLabel?: string
  /** Prefilled body, for editing an existing comment. */
  initialValue?: string
  autoFocus?: boolean
  onSubmit: (body: string) => Promise<unknown>
  /** Shown as a Cancel button when provided. */
  onCancel?: () => void
  className?: string
}

export function CommentComposer({
  placeholder = 'Leave a comment',
  submitLabel = 'Comment',
  initialValue = '',
  autoFocus = false,
  onSubmit,
  onCancel,
  className
}: CommentComposerProps) {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const canSubmit = value.trim().length > 0 && !busy

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value.trim())
      setValue('')
    } catch (caught) {
      // The text stays in the box on failure. Losing a written comment to a
      // transient error is unforgivable in a way that an error message is not.
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape' && onCancel) {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={placeholder}
      />

      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(error)}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">⌘↵ to submit</span>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  )
}
