/**
 * One repository, and the reviews opened against it.
 *
 * The repository itself is re-read here rather than plucked out of the list
 * cache, so the git state shown is current even if you arrived by a link or a
 * reload rather than by clicking through the list.
 */
import { useState } from 'react'
import { AlertCircle, ArrowLeft, FolderOpen, Pencil } from 'lucide-react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { navigate } from '@/lib/router'
import { ReviewList } from '@/features/reviews/review-list'
import { GitStateBadge } from './git-state'
import { RepositoryFormDialog } from './repository-form-dialog'
import type { RepositoryWithGitState } from '@shared/schemas'

export function RepositoryDetail({ repositoryId }: { repositoryId: number }) {
  const [editing, setEditing] = useState(false)

  const { data: repository, error, isLoading } = useSWR<RepositoryWithGitState, unknown>(
    `${CACHE_KEYS.repositories}:${repositoryId}`,
    () => api.repositories.get({ id: repositoryId })
  )

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading repository">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error !== undefined || !repository) {
    return (
      <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-12 text-center">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <div>
          <h3 className="font-medium">Repository not found</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {error === undefined ? 'It may have been removed.' : errorMessage(error)}
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate({ name: 'repositories' })}>
          <ArrowLeft />
          Back to repositories
        </Button>
      </Card>
    )
  }

  const missing = !repository.git.exists

  return (
    <div className="flex flex-col gap-5">
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

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight" title={repository.name}>
                {repository.name}
              </h1>
              <GitStateBadge git={repository.git} />
            </div>
            <p
              data-selectable
              className="mt-1 truncate font-mono text-xs text-muted-foreground"
              title={repository.path}
            >
              {repository.path}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              title={missing ? 'Folder is missing' : 'Show in file manager'}
              aria-label="Show in file manager"
              disabled={missing}
              onClick={() => void api.system.revealPath(repository.path)}
            >
              <FolderOpen />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Edit repository"
              aria-label="Edit repository"
              onClick={() => setEditing(true)}
            >
              <Pencil />
            </Button>
          </div>
        </div>
      </div>

      <ReviewList repositoryId={repository.id} />

      <RepositoryFormDialog open={editing} onOpenChange={setEditing} repository={repository} />
    </div>
  )
}
