/**
 * "That review is on a machine you have not added yet" - and the way to add it.
 *
 * ## The bug this replaces
 *
 * A link minted on another machine carries that machine's instance id, and
 * since M6.7 the route keeps it, so the reads go out to a host this install may
 * never have been told about. `requireInstance` refused by name and always had:
 * *"This GitWarren does not know a host with id …"*. What nobody had noticed is
 * where that sentence landed. It was the grey subtitle of a card headed
 * **Review not found**, under a button reading **Back to repositories** that
 * navigated with the host scope still attached - so the heading blamed the
 * review for the absence of a computer, and the only way out led to the same
 * unreachable machine's repository list, where it failed again.
 *
 * Every part of the answer was already computed. None of it was offered.
 *
 * ## What it does instead
 *
 * Leads with the cause, then tries to finish the errand. A link is a person
 * trying to get somewhere, and an error screen that knows where they were going
 * and does not take them there is a screen that has given up early.
 *
 * ## Why it probes the tailnet without being asked
 *
 * `core/hosts/discover.ts` is emphatic that discovery runs only when somebody
 * opens the Hosts screen or presses "Look again" - never on a timer, never at
 * startup, never to render the home screen - because it connects to machines
 * and costs about a second of probe timeout.
 *
 * This card is the case that rule was not written about, and it obeys the
 * reason rather than the letter. It is not a timer and not a screen anybody
 * lands on by accident: it draws only when a link this person just clicked
 * named a machine that is missing, which is exactly the moment "which machine
 * is that?" is the only question on the screen. It is one round of probes, once
 * per visit, in direct response to a click - the same bargain `hosts-page.tsx`
 * already strikes when it reaches a host that has just been added.
 *
 * It also costs nothing at all on a machine with no Tailscale: `discoverPeers`
 * answers an empty list without touching the network, which is the same shape
 * `hosts.distros` uses so that no code anywhere asks what platform it is on.
 * The cache key is shared with the Hosts screen, so walking from here to there
 * does not probe twice.
 *
 * ## Why adding is not the end of it
 *
 * `hosts.add` inserts a row with `instance_id` NULL - the id is learned on the
 * first successful connect, in `recordSeen`. So "I have added the machine the
 * link named" is not a fact the Add button can know; it becomes true one probe
 * later. That is why this adds, probes, and only then compares the id it
 * learned against the id the link carried. A machine that turns out to be a
 * different computer leaves the person here with a sentence saying so, rather
 * than bouncing them to a review that would fail again.
 */
import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { ArrowLeft, Plus, Server, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Breakable } from '@/components/breakable'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { navigate } from '@/lib/router'
import { clearPendingDestination, rememberDestination } from '@/lib/pending-destination'
import { HOME, type Route } from '@shared/routes'
import type { DiscoveredPeer } from '@shared/schemas'
import { useHostMutations } from './use-hosts'

/** What the person was trying to open, for the first sentence. */
export type UnknownHostSubject = 'review' | 'repository' | 'repositories'

/**
 * The whole heading per subject rather than a noun slotted into one sentence.
 *
 * A shared template wanted "Those repositories is on another machine" for the
 * plural case, and the fix for that is not a pluralisation helper for three
 * fixed strings - it is three fixed strings.
 */
const SUBJECT_HEADING: Record<UnknownHostSubject, string> = {
  review: 'That review is on another machine',
  repository: 'That repository is on another machine',
  repositories: 'Those repositories are on another machine'
}

export interface UnknownHostCardProps {
  /** The instance id the link named, which is not in the host list. */
  host: string
  /** Where the person was going, host segment and all. */
  route: Route
  subject: UnknownHostSubject
  /** The refusal from `requireInstance`, shown as the supporting detail. */
  error: unknown
}

export function UnknownHostCard({
  host,
  route,
  subject,
  error
}: UnknownHostCardProps): React.JSX.Element {
  const { addHost, probeHost } = useHostMutations()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Written down before anything else, so that walking off to the Hosts screen
  // and adding the machine by hand still comes back here.
  //
  // Keyed on the serialised route rather than the object, because every caller
  // builds the route inline and a fresh object each render would re-run this on
  // every revalidation. `rememberDestination` is idempotent as well, so the
  // Hosts screen is not redrawn either way; this only keeps the effect honest
  // about when the errand actually changed.
  const serialisedRoute = JSON.stringify(route)
  useEffect(() => {
    rememberDestination({ host, route: JSON.parse(serialisedRoute) as Route })
  }, [host, serialisedRoute])

  // See the header for why this runs on its own. Shares `CACHE_KEYS.discovered`
  // with the Hosts screen, and keeps that screen's rules about not repeating
  // itself: no refresh on focus, no interval.
  const { data: peers, isLoading } = useSWR<DiscoveredPeer[], unknown>(
    CACHE_KEYS.discovered,
    () => api.hosts.discover(),
    { revalidateOnFocus: false, revalidateIfStale: false, refreshInterval: 0 }
  )

  // The machine the link named, if it happens to be answering on this tailnet.
  // Matched on the instance id and nothing else: a name is what a person calls
  // a box and two of them can be the same computer, while the id is the only
  // field that tells two names for one machine apart.
  const found = peers?.find((peer) => peer.instanceId === host) ?? null

  async function addAndOpen(peer: DiscoveredPeer): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      const created = await addHost({
        target: peer.origin,
        kind: 'websocket',
        label: peer.dnsName.split('.')[0]
      })
      // The probe is what learns the instance id; see the header. It also
      // clears this row's "Not tried yet", which is the same reason
      // `hosts-page.tsx` probes a host somebody has just added.
      const probed = await probeHost(created.id)
      if (probed.instanceId === host) {
        clearPendingDestination()
        navigate(route)
        return
      }
      setFailure(
        `${peer.dnsName} was added, but it is a different machine from the one the link names. ` +
          'The machine that owns this review is somewhere else.'
      )
    } catch (caught) {
      setFailure(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-12 text-center">
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        <ServerOff className="size-6" />
      </div>

      <div>
        <h3 className="font-medium">{SUBJECT_HEADING[subject]}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {/* The refusal's own sentence, which names the id. Not reworded here:
              two spellings of one refusal is two things to keep in step, and
              the core's is the one the browser shell repeats verbatim. */}
          {errorMessage(error)}
        </p>
        <p className="mx-auto mt-2 max-w-md font-mono text-xs text-muted-foreground">
          <Breakable text={host} />
        </p>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Looking for it on your tailnet…</p>
      )}

      {!isLoading && found && (
        <div className="flex flex-col items-center gap-2">
          <p className="max-w-md text-sm">
            It is answering on your tailnet as <Breakable text={found.dnsName} />.
          </p>
          <Button onClick={() => void addAndOpen(found)} disabled={busy}>
            <Plus />
            {busy ? 'Adding…' : 'Add it and open the review'}
          </Button>
        </div>
      )}

      {!isLoading && !found && (
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          {/* Says what to do next rather than only what failed. A machine
              reached over SSH or WSL cannot be discovered at all - discovery is
              a tailnet probe - so "not found here" is emphatically not "not
              reachable", and sending somebody to the Hosts screen is the honest
              next step rather than a consolation. */}
          It is not answering on your tailnet. If you reach that machine over SSH or WSL, add it on
          the Hosts screen and this will open.
        </p>
      )}

      {failure && <p className="max-w-md text-sm text-destructive">{failure}</p>}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* The errand is kept, deliberately: the Hosts screen offers the way
            back once the machine turns up. See `pending-destination.ts`. */}
        <Button variant="outline" onClick={() => navigate({ name: 'hosts' })}>
          <Server />
          Open Hosts
        </Button>
        {/* And here it is dropped, because this is the person saying they are
            done with it. Navigating HOME rather than to `repositories` with the
            scope still attached is the whole of the escape-hatch fix: the old
            button kept the unknown host and failed again on arrival. */}
        <Button
          variant="ghost"
          onClick={() => {
            clearPendingDestination()
            navigate(HOME)
          }}
        >
          <ArrowLeft />
          Back to this computer
        </Button>
      </div>
    </Card>
  )
}
