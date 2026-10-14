/**
 * Another machine's repositories, as a section of this machine's list.
 *
 * Each host is its own section with its own read, so one machine that is asleep
 * costs that section a line of grey text and nothing else: the local rows above
 * it, and every other host's rows, arrive on their own schedule. One query for
 * "every repository everywhere" would be exactly as fast as the slowest `ssh`
 * handshake in the list and would fail as a whole when any one of them did.
 *
 * ## Why the section is wrapped in a host scope
 *
 * The card, the edit dialog and the remove dialog all find their machine
 * through `useApi()` and `useHostScope()`, so putting the section inside a
 * `HostScopeProvider` is what makes "edit" on a `pc-wsl` row rename the
 * repository on `pc-wsl` - and makes the row open `#/h/<id>/repositories/3`
 * rather than repository 3 on this computer, which is a different repository or
 * none. The dialogs live *inside* the provider for that reason: rendered up in
 * the list, they would be bound to this machine and would act on a row with
 * the same id here. Doing something plausible to the wrong repository is the
 * failure shape every multi-host change in this app has been written against.
 *
 * The read is `useRepositories()`, the same hook and therefore the same SWR key
 * as that host's own repository screen - so opening the host's screen after
 * seeing its rows here is instant, and a refresh in either place is a refresh
 * of both.
 */
import { useState } from 'react'
import { Server } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { errorMessage, isDisconnection } from '@/lib/errors'
import { HostScopeProvider } from '@/lib/host-scope'
import { RepositoryCard, type Elsewhere } from './repository-card'
import { RepositoryFormDialog } from './repository-form-dialog'
import { RemoveRepositoryDialog } from './remove-repository-dialog'
import { useRepositories } from './use-repositories'
import type { HostWithState, RepositoryWithGitState } from '@shared/schemas'

export function RemoteRepositories({
  host,
  clones
}: {
  /** A host that has been reached at least once, so its instance id is known. */
  host: HostWithState & { instanceId: string }
  /** This computer's clones by root commit, for the "also here" link. */
  clones: Map<string, Elsewhere>
}) {
  return (
    <HostScopeProvider host={host.instanceId}>
      <HostSection label={host.label} clones={clones} />
    </HostScopeProvider>
  )
}

function HostSection({ label, clones }: { label: string; clones: Map<string, Elsewhere> }) {
  const { repositories, error, isLoading } = useRepositories()
  const [editing, setEditing] = useState<RepositoryWithGitState | undefined>(undefined)
  const [removing, setRemoving] = useState<RepositoryWithGitState | null>(null)

  // A machine with nothing tracked adds a heading over an empty space to
  // somebody else's home screen. Said nothing about rather than "0 tracked":
  // the host's own screen is where that is worth knowing.
  if (!isLoading && error === undefined && repositories?.length === 0) return null

  return (
    <section className="flex flex-col gap-2" aria-label={`Repositories on ${label}`}>
      <h3 className="flex items-center gap-1.5 pt-2 text-xs font-medium text-muted-foreground">
        <Server className="size-3.5 shrink-0" />
        <span data-selectable className="break-words">
          {label}
        </span>
        {isLoading && <span className="font-normal">· loading…</span>}
      </h3>

      {/* Quiet, and on one line: a laptop on another desk being closed is an
          ordinary state of the world and not a failure of this screen. Rows
          already read stay below it - they are the last true answer that
          machine gave, the same rule the host's own list follows. */}
      {error !== undefined && (
        <p className="text-xs text-muted-foreground" title={errorMessage(error)}>
          {isDisconnection(error)
            ? `${label} is not answering${repositories ? ', so these may be out of date' : ''}.`
            : `Could not read the repositories on ${label}.`}
        </p>
      )}

      {repositories && repositories.length > 0 && (
        <ul className="flex flex-col gap-2">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <RepositoryCard
                repository={repository}
                onEdit={setEditing}
                onRemove={setRemoving}
                badge={
                  <Badge variant="outline" title={`This repository is on ${label}`}>
                    <Server />
                    {label}
                  </Badge>
                }
                alsoHere={
                  repository.git.rootCommit === null
                    ? undefined
                    : clones.get(repository.git.rootCommit)
                }
              />
            </li>
          ))}
        </ul>
      )}

      <RepositoryFormDialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
        repository={editing}
      />
      <RemoveRepositoryDialog
        repository={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      />
    </section>
  )
}
