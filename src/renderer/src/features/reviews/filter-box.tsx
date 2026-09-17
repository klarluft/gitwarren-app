/**
 * The one-line filter that sits above a file list.
 *
 * Shared by both sidebars so that the gesture is the same in either tab: type,
 * get a ranked flat list, press Escape to have the tree back. It is sticky
 * inside the column, because the column scrolls and a filter you have to scroll
 * up to reach is a filter you retype instead.
 */
import { Search, X } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

export function FilterBox({
  value,
  onChange,
  placeholder,
  label,
  className
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** What the box filters, said in full for a screen reader. */
  label: string
  className?: string
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Escape' || value === '') return
    // Clears the box rather than letting the key reach whatever is listening
    // for it further out - a dialog, the tab's own shortcuts. One press, one
    // thing undone.
    event.preventDefault()
    event.stopPropagation()
    onChange('')
  }

  return (
    <div
      className={cn(
        'sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-card px-2 py-1.5',
        className
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        // `search` rather than `text` for the browser's own clear affordance and
        // for the keyboard it brings up on a touch device.
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear the filter"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
