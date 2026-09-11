/**
 * Machines on the tailnet that are not in the list yet.
 *
 * The visible half of "the PC appears on the Mac with no configuration", and
 * the whole of what this component is careful about is that *appears* must not
 * become *is added*. `isLocalOnly` refuses the whole `hosts.` prefix so a hub
 * cannot be talked into becoming a mesh; a discovery that inserted rows would
 * walk around that from the other side. So each peer is a proposal with a
 * button, and pressing it is a person deciding.
 *
 * ## Why it only asks when this screen is open
 *
 * `useSWR` with no `refreshInterval` and no revalidation on focus, which is
 * unusual in this app and deliberate here: `hosts.discover` is the one read
 * that costs a connection attempt per peer on the tailnet. A key that anything
 * else subscribed to would turn opening any screen into a scan, and a poll
 * would make this application a thing that quietly connects to every machine
 * you own. M4.3 refused to do that to render a home screen.
 *
 * So it runs when the Hosts screen mounts, and again when somebody presses
 * "Look again" - which is the same argument as `hosts.probe` ignoring the
 * backoff: a person pressing a button knows something a timer does not.
 *
 * ## A machine you already have is shown, not hidden
 *
 * `pc-wsl` is already an `ssh` row on this Mac from M4, and it is the same box.
 * Dropping it from the list would be the same mistake M5.2 refused for
 * distributions: a listing that silently omits rows is one you cannot trust
 * when the thing you wanted is not in it. So it is shown, greyed, naming the
 * row it is already in the list as - which is M4.1's collision report said one
 * step earlier, before an insert rather than after a connection.
 */
import { useState } from 'react'
import useSWR from 'swr'
import { Radar, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Breakable } from '@/components/breakable'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useHostMutations } from './use-hosts'
import type { DiscoveredPeer } from '@shared/schemas'

export function DiscoveredHosts() {
  const {
    data: peers,
    isLoading,
    isValidating,
    mutate
  } = useSWR<DiscoveredPeer[], unknown>(CACHE_KEYS.discovered, () => api.hosts.discover(), {
    // See the header. This read connects to machines, so it happens when a
    // person is looking at the screen that shows it and at no other time.
    revalidateOnFocus: false,
    revalidateIfStale: false,
    refreshInterval: 0
  })
  const { addHost } = useHostMutations()
  const [adding, setAdding] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Nothing at all until there is something to say. A machine with no Tailscale
  // gets an empty answer - the same shape `hosts.distros` uses so that no code
  // anywhere asks what platform it is on - and an empty section with a heading
  // would be a permanent question the user cannot answer.
  if (isLoading || !peers || peers.length === 0) return null

  async function add(peer: DiscoveredPeer): Promise<void> {
    setAdding(peer.dnsName)
    setFailure(null)
    try {
      // The origin the probe actually answered at, not the name it was asked
      // under. Nothing is guessed about the scheme or the port, which is M6.0's
      // finding applied: whether a tailnet can do HTTPS is a property of the
      // tailnet, so it is a fact to carry rather than a default to apply.
      await addHost({ target: peer.origin, kind: 'websocket', label: peer.dnsName.split('.')[0] })
      await mutate()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setAdding(null)
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Radar className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="text-sm font-medium">On your tailnet</h2>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => void mutate()}
          disabled={isValidating}
          aria-label="Look again"
        >
          <RefreshCw className={isValidating ? 'animate-spin' : undefined} />
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {peers.map((peer) => (
          <li key={peer.instanceId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-40 flex-1 text-sm">
              <span className="font-mono text-xs">
                <Breakable text={peer.dnsName} />
              </span>
              {peer.version ? (
                <span className="ml-2 text-xs text-muted-foreground">{peer.version}</span>
              ) : null}
            </span>
            {peer.alreadyAdded === null ? (
              <Button size="sm" onClick={() => void add(peer)} disabled={adding !== null}>
                <Plus />
                Add
              </Button>
            ) : (
              // Named rather than just disabled: "you have this already" is not
              // useful without "as what", and one machine reached two ways is
              // exactly the case a person is confused by.
              <span className="text-xs text-muted-foreground">
                Already added as {peer.alreadyAdded}
              </span>
            )}
          </li>
        ))}
      </ul>

      {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
    </Card>
  )
}
