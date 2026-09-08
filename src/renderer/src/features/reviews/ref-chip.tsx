/**
 * A ref name in the review header, which you can get back out again.
 *
 * The app sets `user-select: none` on the body - it is chrome, not a document -
 * and that quietly made the one string a reviewer most often needs elsewhere
 * (the branch they are about to check out) impossible to take with them. So
 * this does both: the name is `data-selectable`, so a drag selects it the way
 * it would anywhere else, and a copy button sits beside it for the far more
 * common case of wanting the whole name in one click.
 *
 * The button is always rendered rather than revealed on hover. An affordance
 * that only exists once you have found it is not much of an affordance, and at
 * this size it costs a few pixels.
 */
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Breakable } from '@/components/breakable'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface RefChipProps {
  name: string
  /** What the ref is, for the copy button's label: "base ref", "compare ref". */
  role: string
  className?: string
}

export function RefChip({ name, role, className }: RefChipProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  // The chip outlives no navigation, but the timer can: unmounting mid-flash
  // would otherwise set state on a gone component.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(name)
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    // Long enough to be read, short enough that the button is itself again
    // before the reviewer next looks at it.
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded bg-muted py-0.5 pl-1.5 pr-0.5',
        className
      )}
    >
      {/* No `title`: the name is shown in full - it wraps rather than clips -
          and a tooltip repeating it would only shadow the more useful one on
          the copy button beside it. */}
      <span data-selectable className="min-w-0 break-words">
        <Breakable text={name} />
      </span>
      <Tooltip label={copied ? 'Copied' : `Copy ${role}`}>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? `${role} copied` : `Copy ${role}`}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded transition-colors',
            'text-muted-foreground hover:bg-foreground/10 hover:text-foreground'
          )}
        >
          {copied ? (
            <Check className="size-3 text-success" />
          ) : (
            <Copy className="size-3" />
          )}
        </button>
      </Tooltip>
    </span>
  )
}
