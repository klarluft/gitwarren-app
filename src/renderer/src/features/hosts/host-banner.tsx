/**
 * "You are looking at another machine", and the way back.
 *
 * The one piece of chrome M4.3 adds, and it is deliberately a strip above every
 * screen rather than a badge on each of them. Once a repository list, a review
 * and a diff can all belong to a different computer, *which* computer is the
 * thing a person has to be able to check without thinking - and a component
 * that has to be remembered on each screen is a component that will be missing
 * from the one that mattered.
 *
 * It renders nothing at all on a local route, which is nearly every route this
 * app has ever produced. That asymmetry is the same one the routes have: a
 * local location looks exactly as it always did, and the machinery only shows
 * itself when there is something to say.
 *
 * The host's *label* is what is shown, not the instance id in the URL. The id
 * is how machines refer to each other and a UUID is not a name; the label is
 * what the person typed. A host that has been forgotten since the link was
 * written has no label to show, and saying so here is better than a screen full
 * of `NOT_FOUND` with no explanation of which machine failed to be found.
 */
import { Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHost } from '@/lib/host-scope'
import { navigate } from '@/lib/router'
import { useHosts } from './use-hosts'
import { ReachabilityBadge } from './host-status'

export function HostBanner() {
  const host = useHost()
  // Unconditional: a hook cannot be skipped, and the host list is one local
  // SQLite read that the home screen has already made and SWR has already
  // cached. The early return is below.
  const { hosts } = useHosts()

  if (host === undefined) return null

  const row = hosts?.find((candidate) => candidate.instanceId === host)

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed px-3 py-2">
      <Server className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <p className="text-sm font-medium">
          {row ? row.label : 'A host this GitWarren no longer knows'}
        </p>
        {row ? (
          <ReachabilityBadge host={row} />
        ) : (
          // The id, in this one case, because it is all there is - and because
          // it is what the person can compare against the Hosts screen to work
          // out which machine the link was written on.
          <span data-selectable className="font-mono text-xs text-muted-foreground">
            {host}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        onClick={() => navigate({ name: 'repositories' })}
      >
        Back to this computer
      </Button>
    </div>
  )
}
