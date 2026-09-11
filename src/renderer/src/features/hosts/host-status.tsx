/**
 * The two things a host row has to say before anything else: can we reach it,
 * and what is installed on it.
 *
 * Split out of the card because both are read in more than one place - the card
 * and the install dialog's "before" line - and because deciding what a state
 * *means* is the part worth having on its own. A `HostConnectionState` has four
 * fields and none of them is "up"; the row on screen has to be one word.
 *
 * ## Never tried is not the same as down
 *
 * `failures: 0, connected: false` is a host nobody has spoken to yet, which is
 * the state every host is in for the first few seconds of its life. Rendering
 * that as "unreachable" would mean every host anyone adds is red before it has
 * been given a chance, which teaches people to ignore the colour. It gets its
 * own, quieter word and no colour at all.
 *
 * ## The same distinction, for what is installed
 *
 * `daemon_version` is null in two situations that are not the same situation:
 * the machine was asked and had no GitWarren on it, and the machine has never
 * been asked anything at all. Until now both drew "GitWarren not installed",
 * which made every freshly added host accuse a machine of missing software
 * before a single packet had been sent to it - and the accusation was often
 * wrong, as pressing refresh immediately proved.
 *
 * Which one it is cannot be read off `daemonVersion` alone; it is read off the
 * reachability beside it. A host that has never been tried knows nothing about
 * its own contents either, so `reachabilityOf(...) === 'unknown'` is exactly
 * the condition under which the install badge has to keep quiet. Anything that
 * has actually been reached - or has actually failed, which for ssh is where
 * "GitWarren is not installed on xfor@pc-wsl" comes from - has been asked, and
 * the badge speaks.
 */
import { CircleCheck, CircleDashed, CircleX, Download, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { HostWithState } from '@shared/schemas'

export type Reachability = 'up' | 'down' | 'unknown'

/**
 * `observed` is the asking side's own evidence, and it wins.
 *
 * A row's `state` comes from the pool, but the *row* is a read like any other
 * and is exactly as old as the last time the list was fetched. M4.5 found the
 * two saying different things out loud: open a review on a host in a window
 * that has just started, and the strip above the diff said "Not tried yet"
 * about the machine that had this moment served it - because `hosts.list` was
 * answered before anything had connected and nothing re-asked. Whoever has had
 * an answer out of the machine knows better than a cached list, in exactly the
 * way `lib/host-reachability.ts` argues about the disconnection itself.
 *
 * Undefined when the caller has observed nothing, which is not the same as
 * having observed nothing good - see the paragraph above about never tried.
 */
export function reachabilityOf(host: HostWithState, observed?: Reachability): Reachability {
  if (observed !== undefined) return observed
  if (host.state.connected) return 'up'
  // A host with a failure behind it is down even while its backoff is running;
  // a host with none has simply not been asked.
  return host.state.failures > 0 || host.state.lastError ? 'down' : 'unknown'
}

export function ReachabilityBadge({
  host,
  observed
}: {
  host: HostWithState
  observed?: Reachability
}) {
  switch (reachabilityOf(host, observed)) {
    case 'up':
      return (
        <Badge variant="success">
          <CircleCheck />
          Reachable
        </Badge>
      )
    case 'down':
      return (
        <Badge variant="destructive">
          <CircleX />
          Unreachable
        </Badge>
      )
    case 'unknown':
      return (
        <Badge variant="outline">
          <CircleDashed />
          Not tried yet
        </Badge>
      )
  }
}

/**
 * What is installed over there, compared with what is running here.
 *
 * `appVersion` is passed in rather than read here so the comparison is made
 * against the version that would actually be installed - `app-info` answers for
 * whichever GitWarren the screen is talking to, which in a browser tab is the
 * daemon and not the app.
 */
export function DaemonVersionBadge({
  host,
  appVersion,
  checking = false
}: {
  host: HostWithState
  appVersion: string | undefined
  /** True while a probe for this host is in flight. */
  checking?: boolean
}) {
  if (host.daemonVersion === null) {
    // Asked nothing, so claim nothing. See the header.
    if (reachabilityOf(host) === 'unknown') {
      return checking ? (
        <Badge variant="outline">
          <Loader2 className="animate-spin" />
          Checking…
        </Badge>
      ) : (
        <Badge variant="outline">Not checked yet</Badge>
      )
    }

    return (
      <Badge variant="outline">
        <Download />
        GitWarren not installed
      </Badge>
    )
  }

  // Unknown local version: the badge still names what is over there, because
  // that is a fact, and says nothing about whether it is current, because that
  // is not knowable yet.
  if (appVersion === undefined || host.daemonVersion === appVersion) {
    return <Badge variant="outline">GitWarren {host.daemonVersion}</Badge>
  }

  return (
    <Badge variant="warning">
      <Download />
      GitWarren {host.daemonVersion} · {appVersion} available
    </Badge>
  )
}

/**
 * Whether the install button should be the loud one.
 *
 * Never for a host nobody has asked yet. A filled, primary-coloured "Install
 * GitWarren" is this screen telling somebody what to do next, and it has no
 * business doing that on a guess - the machine may well already have it, which
 * is the whole point of the badge above keeping quiet. The button is still
 * there and still works; it just stops shouting until there is something to
 * shout about.
 */
export function needsInstall(host: HostWithState, appVersion: string | undefined): boolean {
  if (host.daemonVersion === null) return reachabilityOf(host) !== 'unknown'
  return appVersion !== undefined && host.daemonVersion !== appVersion
}
