/**
 * The way to Hosts from the home screen.
 *
 * Same shape as `agent-access-card.tsx`, deliberately: the home screen reads as
 * one list of places, and a second thing that unfolds in place would break
 * that.
 *
 * It shows a count, and only a count. Reading how many hosts there are is a
 * local SQLite read; reading whether any of them is *up* is a connection to
 * every machine in the list, which is not a price the home screen should pay
 * for a subtitle. The Hosts screen is where reachability is asked for, by
 * somebody who went there to ask.
 */
import { ChevronRight, Server } from 'lucide-react'
import useSWR from 'swr'
import { Card } from '@/components/ui/card'
import { api, CACHE_KEYS } from '@/lib/api'
import { navigate } from '@/lib/router'

export function HostsCard() {
  const { data: hosts } = useSWR(CACHE_KEYS.hosts, () => api.hosts.list())

  function open(): void {
    navigate({ name: 'hosts' })
  }

  const count = hosts?.length ?? 0

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
      <Server className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Hosts</p>
        <p className="text-xs text-muted-foreground">
          {count === 0
            ? 'Review code on another machine over ssh — a PC’s WSL, a VPS, a build box'
            : `${count} machine${count === 1 ? '' : 's'} reachable over ssh`}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Card>
  )
}
