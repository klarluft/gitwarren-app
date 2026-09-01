import { ChevronRight, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { api } from '@/lib/api'
import { navigate } from '@/lib/router'
import { GitStateBadge } from './git-state'
import type { RepositoryWithGitState } from '@shared/schemas'

interface RepositoryCardProps {
  repository: RepositoryWithGitState
  onEdit: (repository: RepositoryWithGitState) => void
  onRemove: (repository: RepositoryWithGitState) => void
}

export function RepositoryCard({ repository, onEdit, onRemove }: RepositoryCardProps) {
  const missing = !repository.git.exists

  function open(): void {
    navigate({ name: 'repository', repositoryId: repository.id })
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
      className="flex cursor-pointer items-center gap-4 p-4 transition-colors hover:border-foreground/20"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-medium" title={repository.name}>
            {repository.name}
          </h3>
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

      {/* The row itself opens the repository, so the per-action buttons inside
          it must not also trigger that. */}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
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
          title="Edit"
          aria-label={`Edit ${repository.name}`}
          onClick={() => onEdit(repository)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Remove"
          aria-label={`Remove ${repository.name}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onRemove(repository)}
        >
          <Trash2 />
        </Button>
      </div>

      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Card>
  )
}
