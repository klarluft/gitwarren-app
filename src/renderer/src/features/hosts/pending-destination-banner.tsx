/**
 * "You came here to add the machine that link was from" - and the way back.
 *
 * The second half of the unknown-host recovery. `unknown-host-card.tsx` can
 * finish the errand by itself when the machine is answering on the tailnet,
 * because it can add it and probe it without leaving the screen. Every other
 * machine - reached over SSH, or over `wsl.exe`, or not switched on yet -
 * cannot be discovered at all, so the person has to come here and describe it.
 *
 * This is what stops that walk being one-way. Without it, somebody adds
 * `xfor@pc-wsl`, watches the row go green, and is standing on a list of hosts
 * with no memory of why - the review they clicked half a minute ago is three
 * navigations behind them and its id was never theirs to remember.
 *
 * ## Why it waits for the list rather than for the Add button
 *
 * A host row is inserted with `instance_id` NULL; the id is learned on the
 * first successful connect, in `recordSeen`. So the Add button genuinely cannot
 * know whether the machine somebody just described is the one the link named -
 * `hosts.add` returns a row that does not know its own name yet. One probe
 * later it does, and `hosts-page.tsx` already probes anything just added for
 * its own reasons. So the question this asks is of the *list*, after every
 * revalidation: is the id from the link in it now? That also picks up the cases
 * nobody designed for - the machine was already in the list but had never been
 * connected to, or it was added in another tab.
 *
 * ## Why it stays when the machine is still missing
 *
 * The unmatched state is not a spinner and not an error, it is an orientation:
 * it names what the visit is for and offers to abandon it. An errand that only
 * appeared once it had already succeeded would be invisible during the exact
 * minute it is needed.
 */
import { useSyncExternalStore } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { navigate } from '@/lib/router'
import {
  clearPendingDestination,
  matchPendingDestination,
  pendingDestination,
  subscribeToPendingDestination
} from '@/lib/pending-destination'
import type { Route } from '@shared/routes'
import type { HostWithState } from '@shared/schemas'

/** What the person was trying to open, in words a sentence can use. */
function describe(route: Route): string {
  if (route.name === 'review') return `review ${route.reviewId}`
  if (route.name === 'repository') return 'a repository'
  return 'its repositories'
}

export function PendingDestinationBanner({
  hosts
}: {
  hosts: HostWithState[] | undefined
}): React.JSX.Element | null {
  const destination = useSyncExternalStore(subscribeToPendingDestination, pendingDestination)
  if (!destination) return null

  const matched = matchPendingDestination(hosts)

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {matched
            ? `The machine that link came from is in your list now. It owns ${describe(
                destination.route
              )}.`
            : `You followed a link to ${describe(
                destination.route
              )} on a machine that is not in this list yet.`}
        </p>
        {!matched && (
          // The id, for the same reason `host-banner.tsx` shows it: it is the
          // only thing on screen a person can compare against a row they are
          // about to add, and the only name the link actually carried.
          <p className="mt-1 font-mono text-xs text-muted-foreground">{destination.host}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {matched && (
          <Button
            size="sm"
            onClick={() => {
              clearPendingDestination()
              navigate(matched.route)
            }}
          >
            Open it
            <ArrowRight />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={clearPendingDestination}
          aria-label="Forget where I was going"
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
