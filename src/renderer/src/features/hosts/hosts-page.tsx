/**
 * The Hosts screen: the other machines, and the button that puts GitWarren on
 * one.
 *
 * Its main job is the install, which is why the installer and this screen went
 * in as one change. Everything else here — add, forget, rename — is a form over
 * a table, and none of it is worth a screen on its own; what is worth a screen
 * is the moment where somebody types `xfor@pc-wsl`, presses Install, and a
 * machine that had nothing but git on it can be reviewed from this one.
 *
 * ## It works in both shells, and nothing here knows which one it is in
 *
 * Every button below is one `carrier.request`. In the window that is IPC into
 * the app's core; in a browser tab it is a WebSocket into the daemon's, and
 * what gets managed is that daemon's list of hosts — which is right, because
 * `hosts.*` is answered by whoever is asked and never forwarded (see
 * `shared/rpc.ts`). So this screen needed no `capabilities` check at all, and
 * that is the M3.2 design working rather than an omission: the flags exist for
 * controls a tab genuinely cannot offer, and installing over ssh is not one of
 * them. The install runs wherever the core runs; that it might be a different
 * machine from the browser is exactly the point of the milestone.
 *
 * ## One thing at a time
 *
 * `busy` holds a single host id rather than a set. Two installs at once would
 * be two 45 MB streams and two `ssh` connections from a screen with one
 * spinner, and the honest way to say "this is one operation you are waiting on"
 * is to let it be one.
 */
import { useCallback, useMemo, useState } from 'react'
import useSWR from 'swr'
import { AlertCircle, ArrowLeft, Plus, RefreshCw, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { navigate } from '@/lib/router'
import { useRegisterCommands, type Command } from '@/features/commands/command-registry'
import { DiscoveredHosts } from './discovered-hosts'
import { HostCard } from './host-card'
import { HostFormDialog } from './host-form-dialog'
import { InstallResultDialog, type InstallOutcome } from './install-result-dialog'
import { RemoveHostDialog } from './remove-host-dialog'
import { useHostMutations, useHosts } from './use-hosts'
import type { HostWithState } from '@shared/schemas'

export function HostsPage() {
  const { hosts, error, isLoading, isRefreshing, refresh } = useHosts()
  const { probeHost, installOnHost } = useHostMutations()
  const { data: info } = useSWR(CACHE_KEYS.appInfo, () => api.system.appInfo())

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<HostWithState | undefined>(undefined)
  const [removing, setRemoving] = useState<HostWithState | null>(null)
  const [busy, setBusy] = useState<{ id: number; what: 'probe' | 'install' } | null>(null)
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null)

  const openAdd = useCallback((): void => {
    setEditing(undefined)
    setFormOpen(true)
  }, [])

  function openEdit(host: HostWithState): void {
    setEditing(host)
    setFormOpen(true)
  }

  async function probe(host: HostWithState): Promise<void> {
    setBusy({ id: host.id, what: 'probe' })
    try {
      await probeHost(host.id)
    } catch (caught) {
      // `hosts.probe` answers rather than throws for an unreachable host, so
      // anything landing here is the app failing rather than the machine - and
      // it belongs in front of the person, not in a console.
      setOutcome({ kind: 'error', label: host.label, message: errorMessage(caught) })
    } finally {
      setBusy(null)
    }
  }

  async function install(host: HostWithState): Promise<void> {
    setBusy({ id: host.id, what: 'install' })
    try {
      const report = await installOnHost(host.id)
      setOutcome({ kind: 'done', label: host.label, report })
    } catch (caught) {
      setOutcome({ kind: 'error', label: host.label, message: errorMessage(caught) })
    } finally {
      setBusy(null)
    }
  }

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'hosts:add',
          label: 'Add host',
          group: 'Hosts',
          keys: 'n',
          keywords: 'ssh machine remote server vps wsl',
          icon: Plus,
          run: openAdd
        },
        {
          id: 'hosts:refresh',
          label: 'Refresh hosts',
          group: 'Hosts',
          keys: 'r',
          keywords: 'reload reachable status',
          icon: RefreshCw,
          run: () => void refresh()
        }
      ],
      [openAdd, refresh]
    )
  )

  return (
    <section className="flex flex-col gap-4">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 text-muted-foreground"
          onClick={() => navigate({ name: 'repositories' })}
        >
          <ArrowLeft />
          Repositories
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Server className="size-5 shrink-0 text-muted-foreground" />
              <h1 className="text-xl font-semibold tracking-tight">Hosts</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLoading
                ? 'Loading…'
                : `${hosts?.length ?? 0} machine${hosts?.length === 1 ? '' : 's'}${
                    isRefreshing ? ' · refreshing…' : ''
                  }`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip label="Re-read reachability">
              <Button
                variant="outline"
                size="icon"
                onClick={() => void refresh()}
                disabled={isLoading}
                aria-label="Refresh"
              >
                <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
              </Button>
            </Tooltip>
            <Button onClick={openAdd}>
              <Plus />
              Add host
            </Button>
          </div>
        </div>
      </div>

      {/* Above the list rather than below it: a machine you have not added yet
          is the thing you came here to do something about, and a proposal
          under twelve rows is a proposal nobody sees. It draws nothing at all
          when there is nothing to propose. */}
      <DiscoveredHosts />

      {isLoading && <LoadingState />}

      {!isLoading && error !== undefined && (
        <ErrorState error={error} onRetry={() => void refresh()} />
      )}

      {!isLoading && error === undefined && hosts?.length === 0 && <EmptyState onAdd={openAdd} />}

      {!isLoading && error === undefined && hosts && hosts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {hosts.map((host) => (
            <li key={host.id}>
              <HostCard
                host={host}
                appVersion={info?.version}
                busy={busy?.id === host.id ? busy.what : null}
                onProbe={(target) => void probe(target)}
                onInstall={(target) => void install(target)}
                onEdit={openEdit}
                onRemove={setRemoving}
              />
            </li>
          ))}
        </ul>
      )}

      <HostFormDialog open={formOpen} onOpenChange={setFormOpen} host={editing} />
      <RemoveHostDialog
        host={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      />
      <InstallResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </section>
  )
}

function LoadingState() {
  return (
    <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading hosts">
      {[0, 1].map((index) => (
        <li key={index}>
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-8 w-40 rounded-md" />
          </Card>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="flex flex-col items-center gap-3 border-dashed px-6 py-14 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <Server className="size-6" />
      </div>
      <div>
        <h3 className="font-medium">No other machines yet</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Add a machine you can already reach over ssh — a PC&rsquo;s WSL, a VPS, a build box — and
          GitWarren will install itself there over the same connection. The host needs nothing but
          git.
        </p>
      </div>
      <Button onClick={onAdd} className="mt-1">
        <Plus />
        Add your first host
      </Button>
    </Card>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-12 text-center">
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        <AlertCircle className="size-6" />
      </div>
      <div>
        <h3 className="font-medium">Could not load your hosts</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {errorMessage(error)}
        </p>
      </div>
      <Button variant="outline" onClick={onRetry} className="mt-1">
        <RefreshCw />
        Try again
      </Button>
    </Card>
  )
}
