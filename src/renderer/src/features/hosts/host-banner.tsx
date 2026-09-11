/**
 * "You are looking at another machine", and the way back - and since M4.5, "and
 * it has stopped answering".
 *
 * The one piece of chrome M4.3 added, and it is deliberately a strip above every
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
 *
 * ## The disconnection lives here because it is the same sentence
 *
 * M4.5 needed to say "this machine stopped answering" on an open review, and
 * the first sketch was a banner of its own on the review screen. It would have
 * been wrong twice. Once for the reason above - a diff, a repository list and a
 * conversation tab all go stale together, and three copies of one notice is two
 * chances to forget it. And once because it would have sat next to *this*
 * strip, which is already naming the machine and already showing a badge about
 * whether it is reachable: two components, one about a host, in the same two
 * centimetres of screen, free to disagree.
 *
 * So the strip has two states rather than a neighbour. What it says comes from
 * `lib/host-reachability.ts` - the requests this window is actually making -
 * and not from the `hosts.list` row underneath it, which is a read like any
 * other and is exactly as old as the last time something refreshed it. The
 * badge is dropped while the strip is saying the machine is away, because
 * "Reachable" underneath "pc-wsl stopped answering" is the disagreement in one
 * line.
 *
 * ## Not loaded yet is not the same as not known
 *
 * The host list is a read like any other, and for the first frames of a cold
 * load there is no list - which is not the same claim as "this machine is not
 * in it". Conflating them made a perfectly ordinary host announce itself as "a
 * host this GitWarren no longer knows" for half a second on every reload, which
 * is exactly the lesson `host-status.tsx` already records about a host nobody
 * has spoken to yet: the honest rendering of an unanswered question is not the
 * alarming answer. So the sentence is only reached once the list has actually
 * arrived, and until then the banner says what it does know - that this is
 * somewhere else - and shows the id.
 *
 * The same mistake has a third face here, and it is the one M4.5 could have
 * made: a request in flight is not a disconnection. Nothing on this strip reads
 * `isRefreshing`, and the store it does read only ever moves on an outcome.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { useSWRConfig } from 'swr'
import { PlugZap, RefreshCw, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { timeOfDay } from '@/lib/format'
import { useHost } from '@/lib/host-scope'
import { hostReachability, subscribeToHostChanges } from '@/lib/host-reachability'
import { navigate } from '@/lib/router'
import { useHosts, useHostMutations } from './use-hosts'
import { ReachabilityBadge, type Reachability } from './host-status'
import type { HostWithState } from '@shared/schemas'

export function HostBanner() {
  const host = useHost()
  // Unconditional: a hook cannot be skipped, and the host list is one local
  // SQLite read that the home screen has already made and SWR has already
  // cached. The early return is below.
  const { hosts } = useHosts()
  // Subscribed to rather than polled: the store announces a change of state and
  // nothing else, so this redraws when the machine goes and when it comes back
  // and not once per request. See `lib/host-reachability.ts`.
  const reachability = useSyncExternalStore(subscribeToHostChanges, () => hostReachability(host))
  const { probeHost } = useHostMutations()
  const { mutate } = useSWRConfig()
  const [retrying, setRetrying] = useState(false)

  // Undefined while the list is still on its way; null once it has arrived and
  // this host is genuinely not in it. See the note above.
  const row =
    host === undefined || hosts === undefined
      ? undefined
      : (hosts.find((candidate) => candidate.instanceId === host) ?? null)

  /**
   * Try now, and then look again.
   *
   * A plain revalidation would be refused before it reached the network: the
   * pool is holding a backoff timer, and while it runs every request fails fast
   * rather than hopefully. `hosts.probe` is the one call that ignores it, and
   * it exists for precisely this - somebody pressing a button knows something
   * the timer does not, usually that they have just woken the machine.
   *
   * Then every key scoped to that machine, because a screen is half a dozen of
   * them and the person pressed one button. The suffix is `scoped()` in
   * `lib/api.ts` read from the other end; see `use-reconnect.ts`, which does
   * the same thing without being asked.
   */
  const retry = useCallback(async (): Promise<void> => {
    if (!row) return
    setRetrying(true)
    try {
      await probeHost(row.id)
      await mutate((key) => typeof key === 'string' && key.endsWith(`@${host}`))
    } finally {
      setRetrying(false)
    }
  }, [host, mutate, probeHost, row])

  if (host === undefined) return null

  const observed: Reachability | undefined =
    reachability.offlineSince !== null ? 'down' : reachability.lastSeenAt !== null ? 'up' : undefined

  // The loud form is for content that has gone stale, which means there has to
  // be content. Arriving cold at a machine that is already asleep loads
  // nothing, and "stopped answering" is then the wrong tense - it never
  // started. That case belongs to the screen, which has the room to say what
  // happened and the same Try again: `repository-list.tsx` has had exactly that
  // card since M4.3. Two notices one above the other, in the same words, is the
  // duplication this file exists to avoid - so up here it stays one word, in
  // the badge, and the badge now says "Unreachable" because this window has
  // just watched it fail.
  if (reachability.offlineSince !== null && reachability.lastSeenAt !== null) {
    return (
      <Disconnected
        row={row}
        host={host}
        message={reachability.message}
        lastSeenAt={reachability.lastSeenAt}
        onRetry={row ? () => void retry() : undefined}
        retrying={retrying}
      />
    )
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed px-3 py-2">
      <Server className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <p className="text-sm font-medium">
          {row
            ? row.label
            : row === null
              ? 'A host this GitWarren no longer knows'
              : 'Another machine'}
        </p>
        {row ? (
          // This window's own evidence, which beats the row's - see
          // `reachabilityOf`. Undefined when it has none, which leaves the row
          // to answer as it did before M4.5.
          <ReachabilityBadge host={row} observed={observed} />
        ) : (
          // The id, while there is no label to show - and because it is what
          // the person can compare against the Hosts screen to work out which
          // machine the link was written on.
          <span data-selectable className="font-mono text-xs text-muted-foreground">
            {host}
          </span>
        )}
      </div>
      <BackToThisComputer />
    </div>
  )
}

/**
 * The machine went away, and what is on screen is what it last said.
 *
 * Three sentences and a button, in the order somebody reads them: which machine
 * and that it is gone, what the attempt actually said, and how old the thing
 * they are looking at is. The middle one is `ssh`'s own words carried up
 * through the pool - "Permission denied (publickey)", "Could not resolve
 * hostname", "GitWarren is not installed on xfor@pc-wsl" - and it is the only
 * line on the screen that says what to go and fix. Everything M4.1 did to make
 * sure that sentence was the useful one rather than "the connection closed"
 * ends here.
 *
 * The content behind it is left alone: no overlay, no dimming, nothing
 * disabled. A diff that was readable a second ago is still readable, and a
 * reviewer mid-file should not lose their place because a laptop shut its lid.
 * What a stale screen must not do is pretend, and one strip saying so out loud
 * is enough - which is also why there is no per-card marker anywhere below.
 *
 * Writes are deliberately not blocked either. A comment typed against a machine
 * that is away fails on submit with the same sentence, in the composer, where
 * the text still is - and that is a better answer than a disabled button that
 * loses what somebody was in the middle of writing.
 */
function Disconnected({
  row,
  host,
  message,
  lastSeenAt,
  onRetry,
  retrying
}: {
  row: HostWithState | null | undefined
  host: string
  message: string | null
  lastSeenAt: number
  onRetry: (() => void) | undefined
  retrying: boolean
}) {
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
    >
      <PlugZap className="mt-0.5 size-4 shrink-0 text-warning" />
      {/* A floor rather than `min-w-0`, and it is what makes this readable on a
          phone. The buttons beside it are `shrink-0`, so a text column allowed
          to shrink to nothing does: at 390 px `ssh`'s sentence came out one word
          per line down the left of the screen, which passes a no-horizontal-
          scroll check and is unreadable. Below this width the row wraps and the
          buttons take a line of their own. */}
      <div className="flex min-w-[14rem] flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">
          {row ? `${row.label} stopped answering` : 'That machine stopped answering'}
        </p>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
        <p className="text-xs text-muted-foreground">
          Showing what was loaded at {timeOfDay(lastSeenAt)}. GitWarren keeps trying.
        </p>
        {!row && (
          <span data-selectable className="font-mono text-xs text-muted-foreground">
            {host}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Absent rather than disabled while the host list is still loading,
            which is the rule M3 set for a control a shell cannot honour: this
            one needs the row's numeric id to probe with, and a button that
            explains itself when pressed is worse than one that was not there. */}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={retrying ? 'animate-spin' : undefined} />
            Try again
          </Button>
        )}
        <BackToThisComputer />
      </div>
    </div>
  )
}

function BackToThisComputer() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 text-muted-foreground"
      onClick={() => navigate({ name: 'repositories' })}
    >
      Back to this computer
    </Button>
  )
}
