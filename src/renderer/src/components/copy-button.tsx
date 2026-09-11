/**
 * A copy button that says it worked, and says so when it did not.
 *
 * Shared rather than local because two different features want the same
 * behaviour for the same reason: they show a string whose whole purpose is to
 * end up somewhere else - an agent's config file, a phone's address bar - and
 * the app is the only thing standing between the user and retyping it.
 *
 * The refusal path is not theoretical and is why `source` is here. A clipboard
 * write needs a focused document and a permission the browser may simply not
 * give; when it is refused, `writeText` rejects and a button that only ever
 * sets `copied` on success leaves the user pressing it again at a page that
 * does nothing. So a failure selects the text instead - the same thing the
 * person was about to do by hand, done for them, with the keystroke named.
 *
 * ## Placement belongs to the caller
 *
 * The button knows how to copy and nothing about where it sits. The agent
 * page's snippets park it in a `<pre>`'s corner and the tailnet panel stands it
 * next to a URL, which is a `className` away in both cases - and baking one of
 * them in here would make the other one fight it.
 */
import { useState, type RefObject } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

export function CopyButton({
  label,
  text,
  source,
  className,
  children
}: {
  label: string
  text: string
  /** The element holding `text`, selected when the clipboard says no. */
  source: RefObject<HTMLElement | null>
  className?: string
  children?: React.ReactNode
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle')

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
      setTimeout(() => setState('idle'), 1800)
    } catch {
      const element = source.current
      if (element) {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      }
      // Left standing rather than timed out: it is an instruction now, and it
      // stays true until the next press.
      setState('select')
    }
  }

  const icon = state === 'copied' ? <Check className="text-success" /> : <Copy />
  const said = state === 'copied' ? 'Copied' : state === 'select' ? 'Selected — press copy' : null

  // Two shapes, one behaviour: a labelled button when it is the action a page
  // exists for, and the bare icon when it sits beside the thing it copies.
  if (children !== undefined) {
    return (
      <Button onClick={() => void copy()} className={className}>
        {icon}
        {said ?? children}
      </Button>
    )
  }

  return (
    <Tooltip label={said ?? label}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void copy()}
        aria-label={label}
        className={className}
      >
        {icon}
      </Button>
    </Tooltip>
  )
}
