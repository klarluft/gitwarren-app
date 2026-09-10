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
 */
import { CircleCheck, CircleDashed, CircleX, Download } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { HostWithState } from '@shared/schemas'

export type Reachability = 'up' | 'down' | 'unknown'

export function reachabilityOf(host: HostWithState): Reachability {
  if (host.state.connected) return 'up'
  // A host with a failure behind it is down even while its backoff is running;
  // a host with none has simply not been asked.
  return host.state.failures > 0 || host.state.lastError ? 'down' : 'unknown'
}

export function ReachabilityBadge({ host }: { host: HostWithState }) {
  switch (reachabilityOf(host)) {
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
  appVersion
}: {
  host: HostWithState
  appVersion: string | undefined
}) {
  if (host.daemonVersion === null) {
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

/** Whether the install button should be the loud one. */
export function needsInstall(host: HostWithState, appVersion: string | undefined): boolean {
  return host.daemonVersion === null || (appVersion !== undefined && host.daemonVersion !== appVersion)
}
