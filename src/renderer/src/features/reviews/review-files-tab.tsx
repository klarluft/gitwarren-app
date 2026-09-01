/**
 * The files-changed tab.
 *
 * The diff is taken from the merge base, so it shows what head added rather
 * than differences base picked up in the meantime - the same thing a pull
 * request shows.
 *
 * The "include uncommitted changes" switch is view state, not part of the
 * review. Whether you want to read the branch as it stands on disk or as it
 * would arrive if pushed is a question you ask per visit, and each answer is
 * cached under its own SWR key so flipping back is instant.
 */
import { useState } from 'react'
import { AlertCircle, FileDiff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/format'
import { CompareErrorCard, NoWorktreeNotice, WorkingTreeBanner } from './compare-notices'
import { DiffStat, FileDiffCard } from './diff-view'
import { useReviewDiff } from './use-reviews'
import type { Review } from '@shared/schemas'

export function ReviewFilesTab({ review }: { review: Review }) {
  const [includeUncommitted, setIncludeUncommitted] = useState(true)
  const { data, error, isLoading, isRefreshing, refresh } = useReviewDiff(
    review.id,
    includeUncommitted
  )

  if (isLoading) return <LoadingState />

  if (error !== undefined) {
    return (
      <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-10 text-center">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <p className="max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
        <Button variant="outline" onClick={() => void refresh()}>
          <RefreshCw />
          Try again
        </Button>
      </Card>
    )
  }

  if (!data) return null
  if (data.error !== null || data.base.error !== null || data.head.error !== null) {
    return <CompareErrorCard compare={data} />
  }

  const hasWorktree = data.workingTree !== null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {plural(data.files.length, 'file')} changed
          </p>
          <DiffStat additions={data.additions} deletions={data.deletions} />
        </div>

        <div className="flex items-center gap-3">
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title={
              hasWorktree
                ? 'Fold the head worktree’s staged, unstaged and untracked changes into the diff'
                : `No worktree has ${review.headRef} checked out, so there is nothing uncommitted to include`
            }
          >
            <Switch
              checked={includeUncommitted}
              onCheckedChange={setIncludeUncommitted}
              disabled={!hasWorktree}
            />
            Include uncommitted
          </label>

          <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Re-read from disk">
            <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {includeUncommitted && data.workingTree?.isDirty && (
        <WorkingTreeBanner workingTree={data.workingTree} />
      )}
      {!hasWorktree && <NoWorktreeNotice headRef={review.headRef} />}
      {hasWorktree && !includeUncommitted && data.workingTree?.isDirty && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          Uncommitted changes are being left out of this diff. Turn the switch back on to include
          them.
        </p>
      )}

      {data.files.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
          <div className="rounded-full bg-muted p-3 text-muted-foreground">
            <FileDiff className="size-6" />
          </div>
          <h3 className="font-medium">No changes</h3>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            <span className="font-mono">{review.headRef}</span> has nothing that{' '}
            <span className="font-mono">{review.baseRef}</span> does not already have.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {data.files.map((file) => (
            <FileDiffCard key={`${file.oldPath ?? ''}:${file.path}`} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading changes">
      {[0, 1].map((index) => (
        <Card key={index} className="overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2">
            <Skeleton className="size-4" />
            <Skeleton className="h-4 w-56" />
            <div className="flex-1" />
            <Skeleton className="h-4 w-14" />
          </div>
          <div className="space-y-1 border-t border-border p-3">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      ))}
    </div>
  )
}
