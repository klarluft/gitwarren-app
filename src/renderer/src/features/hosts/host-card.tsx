/**
 * One machine, and everything that can be done to it from here.
 *
 * Since M4.3 a host does lead somewhere - `#/h/<instance>/` is its repository
 * list - so there is a button that goes there. The card is still a card rather
 * than one big link, because the other five things on it are actions and a row
 * where clicking anywhere navigates is a row where "Forget" is one slip away.
 *
 * ## The way in appears only once the machine has said who it is
 *
 * `#/h/<instance>/` needs an instance id, and a host that has been described
 * but never reached has none - it is a target somebody typed, and this install
 * cannot yet tell it from any other machine. So the button is absent until the
 * first successful connect writes the id back, and "Try now" is what makes it
 * appear. That is not a limitation worked around; it is the same honesty
 * `instance_id` being nullable buys everywhere else, arriving at the UI.
 *
 * ## Why the failure is on the card and not behind a tooltip
 *
 * `state.lastError` is the sentence `ssh` produced - "Could not resolve
 * hostname", "Permission denied (publickey)", "GitWarren is not installed on
 * xfor@pc-wsl". Every one of those tells the person exactly what to go and fix,
 * and none of them is discoverable if it lives in a tooltip on a red dot. It
 * costs two lines on the rows that are failing and nothing at all on the rows
 * that are not.
 */
import { ChevronRight, Download, Loader2, Pencil, Plug, RefreshCw, Trash2 } from 'lucide-react'
import { Breakable } from '@/components/breakable'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { navigate } from '@/lib/router'
import { DaemonVersionBadge, ReachabilityBadge, needsInstall } from './host-status'
import type { HostWithState } from '@shared/schemas'

interface HostCardProps {
  host: HostWithState
  appVersion: string | undefined
  /** True while this host is the one being probed or installed onto. */
  busy: 'probe' | 'install' | null
  onProbe: (host: HostWithState) => void
  onInstall: (host: HostWithState) => void
  onEdit: (host: HostWithState) => void
  onRemove: (host: HostWithState) => void
}

export function HostCard({
  host,
  appVersion,
  busy,
  onProbe,
  onInstall,
  onEdit,
  onRemove
}: HostCardProps) {
  const wanted = needsInstall(host, appVersion)
  const anythingBusy = busy !== null

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium" title={host.label}>
              {host.label}
            </h3>
            <ReachabilityBadge host={host} />
            <DaemonVersionBadge host={host} appVersion={appVersion} />
          </div>
          {/* Wraps rather than truncates, for the reason the repository card
              gives about paths: the tail of `xfor@100.78.0.23` is the half that
              says which machine this is. */}
          <p data-selectable className="mt-1 break-words font-mono text-xs text-muted-foreground">
            <Breakable text={host.target} />
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="Connect to this host now">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Try ${host.label} now`}
              disabled={anythingBusy}
              onClick={() => onProbe(host)}
            >
              {busy === 'probe' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </Tooltip>
          <Tooltip label="Edit this host">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${host.label}`}
              disabled={anythingBusy}
              onClick={() => onEdit(host)}
            >
              <Pencil />
            </Button>
          </Tooltip>
          <Tooltip label="Forget this host">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${host.label}`}
              className="text-muted-foreground hover:text-destructive"
              disabled={anythingBusy}
              onClick={() => onRemove(host)}
            >
              <Trash2 />
            </Button>
          </Tooltip>
        </div>
      </div>

      {host.state.lastError && !host.state.connected && (
        <p
          role="status"
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <Breakable text={host.state.lastError} />
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={wanted ? 'default' : 'outline'}
          disabled={anythingBusy}
          onClick={() => onInstall(host)}
        >
          {busy === 'install' ? <Loader2 className="animate-spin" /> : <Download />}
          {host.daemonVersion === null
            ? 'Install GitWarren'
            : wanted
              ? 'Update GitWarren'
              : 'Reinstall'}
        </Button>
        {/* The way in. Present only once there is an instance id to route on -
            see the note at the top of the file. */}
        {host.instanceId !== null && (
          <Button
            size="sm"
            variant="outline"
            disabled={anythingBusy}
            onClick={() => navigate({ name: 'repositories', host: host.instanceId as string })}
          >
            Repositories
            <ChevronRight />
          </Button>
        )}
        {/* Said here rather than only in the install dialog: it is the sentence
            that explains why a host with nothing on it is a normal starting
            point rather than a problem to solve before adding it. */}
        {host.daemonVersion === null && (
          <p className="text-xs text-muted-foreground">
            <Plug className="mr-1 inline size-3 align-[-2px]" />
            The host needs nothing but git — GitWarren is sent over the same connection.
          </p>
        )}
      </div>
    </Card>
  )
}
