/**
 * The repository screen, including its loading, empty and error states.
 *
 * The states are kept in one place rather than scattered through the tree so
 * it is obvious that all four are actually handled.
 */
import { useState } from 'react'
import { AlertCircle, FolderGit2, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorCode, errorMessage } from '@/lib/errors'
import { RepositoryCard } from './repository-card'
import { RepositoryFormDialog } from './repository-form-dialog'
import { RemoveRepositoryDialog } from './remove-repository-dialog'
import { useRepositories } from './use-repositories'
import type { RepositoryWithGitState } from '@shared/schemas'

export function RepositoryList() {
  const { repositories, error, isLoading, isRefreshing, refresh } = useRepositories()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<RepositoryWithGitState | undefined>(undefined)
  const [removing, setRemoving] = useState<RepositoryWithGitState | null>(null)

  function openAdd(): void {
    setEditing(undefined)
    setFormOpen(true)
  }

  function openEdit(repository: RepositoryWithGitState): void {
    setEditing(repository)
    setFormOpen(true)
  }

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
          <Button
            variant="outline"
            size="icon"
            onClick={() => void refresh()}
            disabled={isLoading}
            title="Re-read git state"
            aria-label="Refresh"
          >
            <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
          </Button>
          <Button onClick={openAdd}>
            <Plus />
            Add repository
          </Button>
        </div>
      </header>

      {isLoading && <LoadingState />}

      {!isLoading && error !== undefined && <ErrorState error={error} onRetry={() => void refresh()} />}

      {!isLoading && error === undefined && repositories?.length === 0 && (
        <EmptyState onAdd={openAdd} />
      )}

      {!isLoading && error === undefined && repositories && repositories.length > 0 && (
        <ul className="flex flex-col gap-2">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <RepositoryCard
                repository={repository}
                onEdit={openEdit}
                onRemove={setRemoving}
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
