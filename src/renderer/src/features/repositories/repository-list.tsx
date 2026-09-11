/**
 * The repository screen, including its loading, empty and error states.
 *
 * The states are kept in one place rather than scattered through the tree so
 * it is obvious that all four are actually handled.
 *
 * Since M4.3 this is also a whole screen on its own: `#/h/<instance>/` is a
 * host's repositories, and it is the same component, reading through the api
 * the route bound it to. There is no second list component and no `host` prop -
 * see `lib/host-scope.tsx`.
 *
 * ## The list that is offline is a list, not a blank page
 *
 * On a remote host every read here is an `ssh` connection, so "could not load"
 * stops being a broken app and becomes an ordinary answer: the machine is
 * asleep. `HOST_OFFLINE` therefore gets its own state with the sentence `ssh`
 * produced and a Try again, rather than the generic failure a missing git would
 * give - the two need completely different things done about them.
 *
 * Since M4.5 that card is for having *nothing* to show, and only that. A
 * disconnection with rows already on screen leaves them exactly where they are:
 * they are the last true answer that machine gave, nothing has contradicted
 * them, and `HostBanner` says above them that they are old. Replacing a list
 * somebody was reading with a notice about a laptop is the one thing a stale
 * screen is not allowed to cost.
 *
 * ## Clones, and which direction the comparison runs
 *
 * Two checkouts of one project on two machines share a root commit and nothing
 * else - not their path, and usually not their name. So when the list belongs
 * to a host, each row is matched against *this computer's* repositories by root
 * commit, and a match becomes a link to the local clone.
 *
 * It runs in that direction and not the other because of what each list costs.
 * This machine's repositories are one local SQLite read, free from anywhere;
 * another machine's are a connection, and a home screen that annotated its rows
 * with "also on ..." would have to open an `ssh` session to every host in the
 * list in order to render - which is exactly the thing `core/hosts/pool.ts`
 * exists to avoid. The comparison is made where it is free.
 */
import { useCallback, useMemo, useState } from 'react'
import useSWR from 'swr'
import { AlertCircle, FolderGit2, Plus, PlugZap, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorCode, errorMessage, isDisconnection } from '@/lib/errors'
import { useHost } from '@/lib/host-scope'
import { useRegisterCommands, type Command } from '@/features/commands/command-registry'
import { RepositoryCard, type Elsewhere } from './repository-card'
import { RepositoryFormDialog } from './repository-form-dialog'
import { RemoveRepositoryDialog } from './remove-repository-dialog'
import { useRepositories } from './use-repositories'
import type { RepositoryWithGitState } from '@shared/schemas'

/**
 * The local clone of each of these, by root commit.
 *
 * Empty when the list already *is* this computer's - a row is not "also" where
 * it already is. Repositories with no commits yet have no root and are not a
 * group: two empty repositories are two empty repositories.
 *
 * First match wins where a machine has the same project checked out twice. The
 * card carries one line, and "one of the places this also is" is a more useful
 * thing to be told than nothing.
 */
function localClonesByRoot(
  host: string | undefined,
  local: RepositoryWithGitState[] | undefined
): Map<string, Elsewhere> {
  const byRoot = new Map<string, Elsewhere>()
  if (host === undefined || !local) return byRoot

  for (const repository of local) {
    const root = repository.git.rootCommit
    if (root === null || byRoot.has(root)) continue
    byRoot.set(root, {
      path: repository.path,
      // No host on the route: this is the local clone, and a local route is
      // what takes the reader back to this machine.
      route: { name: 'repository', repositoryId: repository.id }
    })
  }
  return byRoot
}

export function RepositoryList() {
  const host = useHost()
  const { repositories, error, isLoading, isRefreshing, refresh } = useRepositories()

  // Always this machine's, whatever the screen is showing. On a local screen
  // this is the same SWR key the line above used, so it costs nothing; on a
  // host's screen it is one local SQLite read.
  const { data: localRepositories } = useSWR<RepositoryWithGitState[], unknown>(
    CACHE_KEYS.repositories(),
    () => api.repositories.list()
  )
  const clones = useMemo(
    () => localClonesByRoot(host, localRepositories),
    [host, localRepositories]
  )

  // The rows stay when the machine that served them goes away; `ErrorState`
  // below is for having nothing to show, not for having something old. See the
  // note at the top of this file.
  const stale = repositories !== undefined && isDisconnection(error)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<RepositoryWithGitState | undefined>(undefined)
  const [removing, setRemoving] = useState<RepositoryWithGitState | null>(null)

  const openAdd = useCallback((): void => {
    setEditing(undefined)
    setFormOpen(true)
  }, [])

  function openEdit(repository: RepositoryWithGitState): void {
    setEditing(repository)
    setFormOpen(true)
  }

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'repositories:add',
          label: 'Add repository',
          group: 'Repositories',
          keys: 'n',
          keywords: 'new track clone folder',
          icon: Plus,
          run: openAdd
        },
        {
          id: 'repositories:refresh',
          label: 'Refresh repositories',
          group: 'Repositories',
          keys: 'r',
          keywords: 'reload git state',
          icon: RefreshCw,
          run: () => void refresh()
        }
      ],
      [openAdd, refresh]
    )
  )

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Repositories</h2>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? 'Loading…'
              : `${repositories?.length ?? 0} tracked${isRefreshing ? ' · refreshing…' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip label="Re-read git state">
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
            Add repository
          </Button>
        </div>
      </header>

      {isLoading && <LoadingState />}

      {!isLoading && error !== undefined && !stale && (
        <ErrorState error={error} onRetry={() => void refresh()} />
      )}

      {!isLoading && (error === undefined || stale) && repositories?.length === 0 && (
        <EmptyState onAdd={openAdd} />
      )}

      {!isLoading && (error === undefined || stale) && repositories && repositories.length > 0 && (
        <ul className="flex flex-col gap-2">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <RepositoryCard
                repository={repository}
                onEdit={openEdit}
                onRemove={setRemoving}
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

      <RepositoryFormDialog open={formOpen} onOpenChange={setFormOpen} repository={editing} />
      <RemoveRepositoryDialog
        repository={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      />
    </section>
  )
}

function LoadingState() {
  return (
    <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading repositories">
      {[0, 1, 2].map((index) => (
        <li key={index}>
          <Card className="flex items-center gap-4 p-4">
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="size-9 rounded-md" />
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
        <FolderGit2 className="size-6" />
      </div>
      <div>
        <h3 className="font-medium">No repositories yet</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Add a local git repository to start reviewing it. You can also add one from an AI agent
          through the MCP server.
        </p>
      </div>
      <Button onClick={onAdd} className="mt-1">
        <Plus />
        Add your first repository
      </Button>
    </Card>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = errorCode(error)

  // A machine that is asleep is not a broken app, and the sentence `ssh`
  // produced ("Could not resolve hostname", "Permission denied (publickey)")
  // is the only thing on the screen that says what to go and fix.
  //
  // It reaches both shells. It did not when M4.3 wrote it: `contextBridge`
  // strips everything but `message` off a rejection, so `AppError.code` did not
  // survive the preload and this branch was unreachable in the window. The
  // `BridgeCarrier` change that landed straight after M4.3 fixed that at the
  // boundary, which is what M4.5 is built on - every "is this a disconnection?"
  // in the renderer is a question about a code.
  if (code === 'HOST_OFFLINE') {
    return (
      <Card className="flex flex-col items-center gap-3 border-dashed px-6 py-12 text-center">
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <PlugZap className="size-6" />
        </div>
        <div>
          <h3 className="font-medium">This host is not answering</h3>
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

  return (
    <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-12 text-center">
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        <AlertCircle className="size-6" />
      </div>
      <div>
        <h3 className="font-medium">Could not load your repositories</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
        {code === 'GIT_UNAVAILABLE' && (
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            GitWarren uses your own git installation. Install git, or make sure it is on your PATH,
            then try again.
          </p>
        )}
      </div>
      <Button variant="outline" onClick={onRetry} className="mt-1">
        <RefreshCw />
        Try again
      </Button>
    </Card>
  )
}
