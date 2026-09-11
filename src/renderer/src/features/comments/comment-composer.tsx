/**
 * The box you type a comment into.
 *
 * Submits on Cmd/Ctrl+Enter as well as on the button, because this is a
 * keyboard-driven screen and reaching for the mouse to post a one-line reply is
 * the kind of friction that stops people commenting at all.
 *
 * There is no author picker and there never will be. What the person types is a
 * human comment because they typed it; see `shared/actors.ts`.
 *
 * ## Source, toolbar and preview - not a rich-text editor
 *
 * This edits markdown *source*, and deliberately so. The `body` column is the
 * interchange format between the person and the agents: an agent writes
 * markdown into it over MCP, the person edits that same string, the agent reads
 * it back. A WYSIWYG editor parses to a document model and re-serialises on
 * every save, which silently reflows an agent's fenced code, its bullet markers
 * and its link style - so a human opening a comment to fix a typo would rewrite
 * text they never touched. GitHub does not have a WYSIWYG editor either;
 * source plus a toolbar plus a preview *is* the experience being copied here.
 *
 * The transformations behind the toolbar and the Enter key live in
 * `markdown-editing.ts`, as pure functions over the text and the selection.
 *
 * ## Images, on a review that belongs to another machine
 *
 * Nothing here knows about that, and that is the design rather than a gap.
 * `api` comes from `useApi()`, so `attachments.ingest` and `attachments.pick`
 * are already bound to the machine the screen is about: the bytes of a pasted
 * screenshot travel to that machine's store, the token comes back naming it,
 * and the same token resolves when the comment is read because
 * `main/attachment-protocol.ts` now asks the same host for the bytes.
 *
 * It was switched off in M4.3 for the half of that which did not exist yet -
 * ingesting worked, displaying did not, so an image really did land on `pc-wsl`
 * and render here as a broken one. M4.4 is that other half, and turning this
 * back on is deleting a guard rather than adding a path.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent
} from 'react'
import {
  Bold,
  Code,
  Image as ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  SquareCode,
  Strikethrough,
  TextQuote
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/markdown'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'
import { useApi } from '@/lib/host-scope'
import { errorMessage } from '@/lib/errors'
import { useKeepAboveKeyboard } from '@/lib/keyboard-inset'
import { cn } from '@/lib/utils'
import {
  BULLET,
  NUMBERED,
  QUOTE,
  TASK,
  continueList,
  insertAtCursor,
  insertLink,
  isUrl,
  toggleLinePrefix,
  wrapCodeBlock,
  wrapInline,
  type EditorState
} from './markdown-editing'

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
  // The app as reached on the machine this review is on. `useApi()` rather than
  // the module-scope `api`, which is always this install - the difference being
  // whether a pasted screenshot lands in the store that can serve it back.
  const api = useApi()
  const [value, setValue] = useState(initialValue)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)

  // On a phone the keyboard covers the bottom of the window, which is where a
  // composer lives; this scrolls the whole box - buttons included - back above
  // it. Does nothing in a window that has no on-screen keyboard.
  useKeepAboveKeyboard(composerRef)

  /**
   * Where the caret should go once React has painted the new value.
   *
   * A controlled textarea puts the caret at the end of the text on every
   * re-render, so a transform that did not restore the selection would leave
   * you at the bottom of the box after bolding a word halfway up it. The
   * selection is applied in a layout effect - after the DOM holds the new
   * value, before the browser paints - so the caret never visibly jumps.
   */
  const pendingSelection = useRef<[number, number] | null>(null)

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  useLayoutEffect(() => {
    const selection = pendingSelection.current
    const textarea = textareaRef.current
    if (!selection || !textarea) return
    pendingSelection.current = null
    textarea.focus()
    textarea.setSelectionRange(selection[0], selection[1])
  }, [value])

  const canSubmit = value.trim().length > 0 && !busy

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value.trim())
      setValue('')
      setTab('write')
    } catch (caught) {
      // The text stays in the box on failure. Losing a written comment to a
      // transient error is unforgivable in a way that an error message is not.
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  /** Read the textarea's live state, so every transform sees the real caret. */
  const readState = useCallback((): EditorState | null => {
    const textarea = textareaRef.current
    if (!textarea) return null
    return {
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd
    }
  }, [])

  const applyEdit = useCallback((next: EditorState): void => {
    pendingSelection.current = [next.selectionStart, next.selectionEnd]
    setValue(next.value)
  }, [])

  /** Run one transform against the current selection, if there is a textarea. */
  const transform = useCallback(
    (fn: (state: EditorState) => EditorState): void => {
      const state = readState()
      if (state) applyEdit(fn(state))
    },
    [applyEdit, readState]
  )

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const modifier = event.metaKey || event.ctrlKey

    // Checked before the shortcuts below so that Cmd+Enter still submits: the
    // formatting shortcuts all carry a letter, so there is no real conflict,
    // but the ordering makes that explicit rather than incidental.
    if (modifier && event.key === 'Enter') {
      event.preventDefault()
      void submit()
      return
    }

    if (event.key === 'Escape' && onCancel) {
      event.preventDefault()
      onCancel()
      return
    }

    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        transform((state) => wrapInline(state, '**'))
        return
      }
      if (key === 'i') {
        event.preventDefault()
        transform((state) => wrapInline(state, '_'))
        return
      }
      if (key === 'k') {
        event.preventDefault()
        transform((state) => insertLink(state))
        return
      }
    }

    if (event.key === 'Enter' && !modifier && !event.shiftKey) {
      const state = readState()
      if (!state) return
      const continued = continueList(state)
      // Null means the caret is not in a list, and an ordinary newline is
      // exactly right - so the default is left alone rather than reimplemented.
      if (continued) {
        event.preventDefault()
        applyEdit(continued)
      }
    }
  }

  /**
   * Copy images into the app and write the markdown for them at the cursor.
   *
   * Ingest happens now, not at submit time, so the token is a live URL
   * immediately and Preview shows the real image before the comment is posted.
   * There is deliberately no `![Uploading…]()` placeholder: GitHub needs one
   * because it is doing a network upload, whereas this is a file copy and a
   * hash, so awaiting it removes a whole class of bug where the placeholder is
   * never replaced.
   */
  const attachFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const images = files.filter((file) => file.type.startsWith('image/'))
      if (images.length === 0) return

      const state = readState()
      if (!state) return

      // Selected text becomes the alt text. It is the only thing that reliably
      // gets alt text written at all, and alt text is what an agent without
      // vision sees of the picture.
      const selected = state.value.slice(state.selectionStart, state.selectionEnd).trim()

      setBusy(true)
      setError(null)
      try {
        const markdown: string[] = []
        for (const [index, file] of images.entries()) {
          const attachment = await api.attachments.ingest({
            bytes: await file.arrayBuffer(),
            originalName: file.name
          })
          const alt = images.length === 1 && selected.length > 0 ? selected : altFor(file, index)
          markdown.push(`![${alt}](${attachment.url})`)
        }
        // Several files from one drop each go on their own line, so they stack
        // rather than running together in a paragraph.
        applyEdit(insertAtCursor(state, markdown.join('\n\n')))
      } catch (caught) {
        // Same rule as a failed submit: the typed text is untouched, and the
        // failure is reported in the slot that is already there for it.
        setError(caught)
      } finally {
        setBusy(false)
      }
    },
    [api, applyEdit, readState]
  )

  /**
   * Pasting a URL over a selection links it; pasting an image attaches it.
   *
   * Anything else falls through to the browser's own paste, which is right far
   * more often than anything clever would be.
   */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files)
    if (files.some((file) => file.type.startsWith('image/'))) {
      event.preventDefault()
      void attachFiles(files)
      return
    }

    const state = readState()
    if (!state || state.selectionStart === state.selectionEnd) return

    const pasted = event.clipboardData.getData('text/plain')
    if (!isUrl(pasted)) return

    event.preventDefault()
    applyEdit(insertLink(state, pasted.trim()))
  }

  /**
   * Open the shell's file picker.
   *
   * A native dialog in the window and an `<input type="file">` in a browser
   * tab; either way the renderer never learns the path of what was chosen, only
   * the token it turned into. Which is why this needs no capability flag - both
   * shells can ask for a file, they just ask differently.
   */
  const pickFile = useCallback(async (): Promise<void> => {
    const state = readState()
    if (!state) return

    setBusy(true)
    setError(null)
    try {
      const attachment = await api.attachments.pick()
      if (attachment === null) return
      const selected = state.value.slice(state.selectionStart, state.selectionEnd).trim()
      const alt = selected.length > 0 ? selected : (attachment.originalName ?? 'image')
      applyEdit(insertAtCursor(state, `![${alt}](${attachment.url})`))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }, [api, applyEdit, readState])

  const disabled = busy

  return (
    <div
      ref={composerRef}
      className={cn('flex flex-col gap-2', className)}
      // The whole composer is the drop target, not just the textarea's
      // rectangle. Dropping a screenshot "on the comment box" means the box as
      // a person sees it, toolbar and buttons included, and a drop that lands
      // two pixels outside and navigates the window away is a bad surprise.
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        // Only when the pointer leaves the composer itself - dragging across a
        // child element fires dragleave for the child and would flicker.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(false)
        void attachFiles(Array.from(event.dataTransfer.files))
      }}
    >
      <Tabs value={tab} onValueChange={(next) => setTab(next as 'write' | 'preview')}>
        <TabsList>
          <TabsTab value="write">Write</TabsTab>
          <TabsTab value="preview">Preview</TabsTab>
        </TabsList>

        <TabsPanel value="write" className="pt-2">
          <div
            className={cn(
              'rounded-md border border-input transition-colors',
              dragging && 'border-primary bg-primary/5'
            )}
          >
            <Toolbar
              disabled={disabled}
              transform={transform}
              onAttach={() => void pickFile()}
            />
            <Textarea
              ref={textareaRef}
              value={value}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              aria-label={placeholder}
              className="min-h-24 rounded-none rounded-b-md border-0 shadow-none focus-visible:outline-none"
            />
          </div>
        </TabsPanel>

        <TabsPanel value="preview" className="pt-2">
          {/*
            The preview renders through the same <Markdown> component the posted
            comment will, which is the only way it can be trusted. A preview
            drawn by a second code path drifts, and a preview that lies is worse
            than no preview at all.
          */}
          <div className="min-h-24 rounded-md border border-input px-3 py-2">
            {value.trim().length > 0 ? (
              <Markdown body={value} />
            ) : (
              <p className="text-sm italic text-muted-foreground">Nothing to preview.</p>
            )}
          </div>
        </TabsPanel>
      </Tabs>

      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(error)}
        </p>
      )}

      {/* Wraps so the hint and the buttons take a line each rather than
          squeezing one another; on a narrow window the hint is three lines of
          its own and left the buttons a sliver. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {dragging
            ? 'Drop to attach'
            : 'Markdown supported · paste or drop an image · ⌘↵ to submit'}
        </span>
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

/**
 * The formatting buttons.
 *
 * `onMouseDown` rather than `onClick`, with the default prevented: a click
 * blurs the textarea before it fires, and a transform that runs after the blur
 * has no selection left to act on. Preventing the default keeps focus where it
 * is, so the caret survives the button press.
 */
function Toolbar({
  disabled,
  transform,
  onAttach
}: {
  disabled: boolean
  transform: (fn: (state: EditorState) => EditorState) => void
  /** Absent when there is nowhere to put an image. See the note at the top. */
  onAttach: (() => void) | undefined
}) {
  const actions = [
    { icon: Bold, title: 'Bold (⌘B)', run: (s: EditorState) => wrapInline(s, '**') },
    { icon: Italic, title: 'Italic (⌘I)', run: (s: EditorState) => wrapInline(s, '_') },
    { icon: Strikethrough, title: 'Strikethrough', run: (s: EditorState) => wrapInline(s, '~~') },
    { icon: Link, title: 'Link (⌘K)', run: (s: EditorState) => insertLink(s) },
    { icon: Code, title: 'Inline code', run: (s: EditorState) => wrapInline(s, '`') },
    { icon: SquareCode, title: 'Code block', run: wrapCodeBlock },
    {
      icon: List,
      title: 'Bulleted list',
      run: (s: EditorState) => toggleLinePrefix(s, BULLET.marker, BULLET.pattern)
    },
    {
      icon: ListOrdered,
      title: 'Numbered list',
      run: (s: EditorState) => toggleLinePrefix(s, NUMBERED.marker, NUMBERED.pattern)
    },
    {
      icon: ListTodo,
      title: 'Task list',
      run: (s: EditorState) => toggleLinePrefix(s, TASK.marker, TASK.pattern)
    },
    {
      icon: TextQuote,
      title: 'Quote',
      run: (s: EditorState) => toggleLinePrefix(s, QUOTE.marker, QUOTE.pattern)
    }
  ]

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1 py-1">
      {actions.map(({ icon: Icon, title, run }) => (
        <Tooltip key={title} label={title}>
          <button
            type="button"
            aria-label={title}
            disabled={disabled}
            onMouseDown={(event) => {
              event.preventDefault()
              transform(run)
            }}
            className={cn(
              'rounded p-1.5 text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <Icon className="size-4" />
          </button>
        </Tooltip>
      ))}

      {/* Absent rather than disabled when there is nowhere to put the image -
          the same rule the reveal button follows. See the note at the top. */}
      {onAttach && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />

          <Tooltip label="Attach an image">
            <button
              type="button"
              aria-label="Attach an image"
              disabled={disabled}
              onMouseDown={(event) => {
                event.preventDefault()
                onAttach()
              }}
              className={cn(
                'rounded p-1.5 text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground',
                'disabled:pointer-events-none disabled:opacity-50'
              )}
            >
              <ImageIcon className="size-4" />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  )
}

/**
 * A default alt text, used only when nothing better is available.
 *
 * The filename is a poor description, but it is not nothing, and an empty alt
 * leaves an agent reading this comment with no idea an image is even there.
 * A selection, when there is one, always wins over this.
 */
function altFor(file: File, index: number): string {
  const name = file.name.replace(/\.[a-z0-9]+$/i, '').trim()
  if (name.length > 0 && name.toLowerCase() !== 'image') return name
  return index === 0 ? 'image' : `image ${index + 1}`
}
