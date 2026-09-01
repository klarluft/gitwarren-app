/**
 * The banners shared by the commits and files tabs.
 *
 * Both tabs have to answer the same three questions before showing anything:
 * did the refs resolve, is there a worktree holding the head branch, and does
 * that worktree have uncommitted work in it? Answering them in one place keeps
 * the two tabs telling the user the same story.
 */
import { AlertCircle, CircleDot, FolderGit2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { plural } from '@/lib/format'
import type { ReviewCompare, WorkingTreeChanges } from '@shared/git'

/** Shown when the comparison itself could not be made. */
export function CompareErrorCard({ compare }: { compare: ReviewCompare }) {
  const message = compare.base.error ?? compare.head.error ?? compare.error

  return (
    <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-10 text-center">
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        <AlertCircle className="size-6" />
      </div>
      <div>
        <h3 className="font-medium">This comparison cannot be read right now</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
          The review itself is untouched — edit it to point at refs that still exist.
        </p>
      </div>
    </Card>
  )
}

/**
 * Where the uncommitted work lives. Worth stating plainly: the directory being
 * read is often not the one the repository was added as.
 */
export function WorkingTreeBanner({ workingTree }: { workingTree: WorkingTreeChanges }) {
  const parts = [
    workingTree.staged > 0 ? `${workingTree.staged} staged` : null,
    workingTree.unstaged > 0 ? `${workingTree.unstaged} unstaged` : null,
    workingTree.untracked > 0 ? `${workingTree.untracked} untracked` : null,
    workingTree.conflicted > 0 ? `${workingTree.conflicted} conflicted` : null
  ].filter((part) => part !== null)

  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <CircleDot className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-warning">
          Uncommitted changes — {parts.join(', ')}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <FolderGit2 className="size-3 shrink-0" />
          <span data-selectable className="truncate font-mono" title={workingTree.worktreePath}>
            {workingTree.worktreePath}
          </span>
        </p>
      </div>
    </div>
  )
}

/** Shown when nothing on disk currently holds the head branch. */
export function NoWorktreeNotice({ headRef }: { headRef: string }) {
  return (
    <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
      No worktree currently has <span className="font-mono">{headRef}</span> checked out, so this
      shows committed work only. Check the branch out — in the main repository or in a linked
      worktree — and any uncommitted changes will appear here.
    </p>
  )
}

/** A one-line summary of the uncommitted state, for the tab headers. */
export function summariseWorkingTree(workingTree: WorkingTreeChanges | null): string | null {
  if (!workingTree?.isDirty) return null
  const changed = workingTree.staged + workingTree.unstaged + workingTree.untracked
  return `${plural(changed, 'uncommitted change')}`
}
