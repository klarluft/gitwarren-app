/**
 * The way to Hosts from the home screen.
 *
 * Same shape as `agent-access-card.tsx`, deliberately: the home screen reads as
 * one list of places, and a second thing that unfolds in place would break
 * that.
 *
 * It shows a count, and it shows whether this machine is reachable - two facts
 * that cost nothing, next to one that would cost a great deal. Reading how many
 * hosts there are is a local SQLite read, and `hosts.tailnet` is a `tailscale`
 * call the home screen was already making when the switch itself lived here; it
 * is the same SWR key, so moving the control to the Hosts screen left the cost
 * where it was rather than adding one. Reading whether any *host* is up is the
 * expensive one - a connection attempt per machine in the list - and that stays
 * on the Hosts screen, asked for by somebody who went there to ask.
 *
 * The tailnet line is state without its control, deliberately. The switch is
 * one click away on the screen that now owns both directions of this, and a
 * second copy of it here would be two controls that can disagree for as long as
 * one of them is mid-flight.
 */
import { ChevronRight, Server } from 'lucide-react'
import useSWR from 'swr'
import { Card } from '@/components/ui/card'
import { api, CACHE_KEYS } from '@/lib/api'
import { navigate } from '@/lib/router'
import { useTailnet } from './use-tailnet'

export function HostsCard() {
  const { data: hosts } = useSWR(CACHE_KEYS.hosts, () => api.hosts.list())
  const { data: tailnet } = useTailnet()

  function open(): void {
    navigate({ name: 'hosts' })
  }

  const count = hosts?.length ?? 0

  // The host name alone rather than the URL: this is a subtitle, and the thing
  // worth copying lives next to the switch that turns it on. `dnsName` is what
  // the machine calls itself on the tailnet, which is the recognisable half.
  const reachable = tailnet?.exposed === true ? tailnet.dnsName : null

  // The long invitation is for a card that has nothing else to say. Once there
  // is a count or an address, it is a sentence in the way of two facts - and
  // the Hosts screen makes the same offer with a button under it.
  const outbound =
    count > 0
      ? `${count} machine${count === 1 ? '' : 's'} over ssh`
      : reachable === null
        ? 'Review code on another machine over ssh — a PC’s WSL, a VPS, a build box'
        : 'No hosts yet'

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
        {/* Wraps rather than truncates: the address is the half most likely to
            run off the end, and half a hostname is worse than two lines. */}
        <p className="text-xs text-muted-foreground">
          {outbound}
          {reachable !== null && (
            <>
              {' · reachable at '}
              <span className="whitespace-nowrap font-mono">{reachable}</span>
            </>
          )}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Card>
  )
}
