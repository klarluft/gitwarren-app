/**
 * The way to Agent Access from the home screen.
 *
 * This was the panel itself until M3.4 - a disclosure that unfolded a prompt, a
 * snippet and three facts in place. What it holds now is a link, because the
 * content became a page (`agent-access-page.tsx`, and the note at the top of it
 * says why). A card that opens a screen is also the shape every other row on
 * this screen already has, so the home screen reads as one list of places
 * rather than one list of places and one thing that grows.
 */
import { ChevronRight, Plug } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { navigate } from '@/lib/router'

export function AgentAccessCard() {
  function open(): void {
    navigate({ name: 'agent' })
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      // Picked up by the j/k shortcuts; the browser's own focus does the rest.
      data-nav-item
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
      className="flex cursor-pointer items-center gap-3 p-4 transition-colors hover:border-foreground/20"
    >
      <Plug className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Agent access</p>
        <p className="text-xs text-muted-foreground">
          One sentence to paste into an agent, so it can manage these repositories over MCP
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Card>
  )
}
