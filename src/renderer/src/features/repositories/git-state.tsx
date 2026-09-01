/**
 * Rendering the live git state of a repository.
 *
 * None of this is stored - it is read every time the list is fetched - so the
 * "missing" and "not a repository" cases are ordinary states to display rather
 * than errors. A repository the user moved should look obviously broken but
 * still be editable, so they can repoint it.
 *
 * Only problems are surfaced: a healthy repository shows no badge at all. The
 * current branch is deliberately not displayed - this app tracks repositories,
 * not what you happen to have checked out at the moment.
 */
import { AlertTriangle, FolderX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { RepositoryGitState } from '@shared/schemas'

export function GitStateBadge({ git }: { git: RepositoryGitState }) {
  if (!git.exists) {
    return (
      <Badge variant="destructive" title={git.error ?? undefined}>
        <FolderX />
        Folder missing
      </Badge>
    )
  }

  if (!git.isGitRepository) {
    return (
      <Badge variant="destructive" title={git.error ?? undefined}>
        <AlertTriangle />
        Not a git repository
      </Badge>
    )
  }

  return null
}
