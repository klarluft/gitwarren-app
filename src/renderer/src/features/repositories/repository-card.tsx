/**
 * One repository, as a row that opens it.
 *
 * Two things on it are decided by *which machine* the list belongs to, and both
 * are the same decision made twice. `Show in file manager` is the shell's, and
 * the shell is on the computer the person is sitting at - so on a repository
 * that lives on `pc-wsl` it would open a Finder window on a path this Mac does
 * not have. Absent, rather than disabled or pointed somewhere plausible.
 *
 * `alsoHere` is the other half of the clone grouping, and it is a *link*
 * because that is the useful shape: the point of knowing that the thing you are
 * looking at on `pc-wsl` is also checked out here is to be able to go and look
 * at the other one. See `groupClones` in `repository-list.tsx` for how two rows
 * on two machines are decided to be one repository.
 */
import { ChevronRight, FolderOpen, Laptop, Pencil, Trash2 } from 'lucide-react'
import { Breakable } from '@/components/breakable'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { api } from '@/lib/api'
import { useHost, useHostScope } from '@/lib/host-scope'
import { navigate } from '@/lib/router'
import { GitStateBadge } from './git-state'
import type { Route } from '@shared/routes'
import type { RepositoryWithGitState } from '@shared/schemas'

/** The same repository, checked out on the computer the person is sitting at. */
export interface Elsewhere {
  path: string
  route: Route
}

interface RepositoryCardProps {
  repository: RepositoryWithGitState
  onEdit: (repository: RepositoryWithGitState) => void
  onRemove: (repository: RepositoryWithGitState) => void
  alsoHere?: Elsewhere | undefined
}

export function RepositoryCard({
  repository,
  onEdit,
  onRemove,
  alsoHere
}: RepositoryCardProps) {
  const host = useHost()
  const scope = useHostScope()
  const missing = !repository.git.exists

  function open(): void {
    navigate({ name: 'repository', repositoryId: repository.id, ...scope })
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      // Picked up by the j/k shortcuts; the browser's own focus does the rest.
      data-nav-item
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
        {/* Wraps rather than truncates. A truncated path loses its tail,
            and the tail is the half that says which checkout this is - two
            worktrees of the same repository share every leading segment and
            differ only at the end. */}
        <p data-selectable className="mt-1 break-words font-mono text-xs text-muted-foreground">
          <Breakable text={repository.path} />
        </p>
        {alsoHere && (
          <button
            type="button"
            // Stops the row's own click: this goes to the *other* clone, which
            // is the whole reason it is here rather than being a label.
            onClick={(event) => {
              event.stopPropagation()
              navigate(alsoHere.route)
            }}
            className="mt-1.5 flex max-w-full items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <Laptop className="size-3 shrink-0" />
            <span className="truncate">Also on this computer: {alsoHere.path}</span>
          </button>
        )}
      </div>

      {/* The row itself opens the repository, so the per-action buttons inside
          it must not also trigger that. */}
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        role="presentation"
      >
        {/* Absent rather than disabled in a browser tab: a disabled button is a
            promise the shell cannot keep, and there is no file manager to put
            in front of someone reading this over loopback in Chrome. Absent for
            the same reason on a remote host, where this machine's file manager
            has no such folder to show. */}
        {api.capabilities.revealPath && host === undefined && (
          <Tooltip label={missing ? 'Folder is missing' : 'Show in file manager'}>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Show in file manager"
              disabled={missing}
              onClick={() => void api.system.revealPath(repository.path)}
            >
              <FolderOpen />
            </Button>
          </Tooltip>
        )}
        <Tooltip label="Edit this repository">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${repository.name}`}
            onClick={() => onEdit(repository)}
          >
            <Pencil />
          </Button>
        </Tooltip>
        <Tooltip label="Remove from GitWarren">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${repository.name}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(repository)}
          >
            <Trash2 />
          </Button>
        </Tooltip>
      </div>

      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Card>
  )
}
