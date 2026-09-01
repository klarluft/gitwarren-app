/**
 * The commits tab.
 *
 * Commits are listed newest first, the way `git log` reports them. Above them,
 * when there is any, sits the uncommitted work - presented as a first-class
 * entry rather than a footnote, because in this app it is frequently the only
 * thing the reviewer is here to look at.
 */
import { AlertCircle, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { absoluteTime, plural, relativeTime } from '@/lib/format'
import { CompareErrorCard, NoWorktreeNotice, WorkingTreeBanner } from './compare-notices'
import { useReviewCommits } from './use-reviews'
import type { GitCommit } from '@shared/git'
import type { Review } from '@shared/schemas'

export function ReviewCommitsTab({ review }: { review: Review }) {
  const { data, error, isLoading, isRefreshing, refresh } = useReviewCommits(review.id)

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

  const { commits, workingTree } = data

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {plural(commits.length, 'commit')}
          {data.truncated && ' (showing the most recent)'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          title="Re-read from disk"
        >
          <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      {workingTree?.isDirty && <WorkingTreeBanner workingTree={workingTree} />}
      {data.headWorktree === null && <NoWorktreeNotice headRef={review.headRef} />}

      {commits.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
          <div className="rounded-full bg-muted p-3 text-muted-foreground">
            <GitCommitHorizontal className="size-6" />
          </div>
          <h3 className="font-medium">No commits yet</h3>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {workingTree?.isDirty
              ? 'Everything in this review is still uncommitted. The files changed tab has it.'
              : `${review.headRef} has nothing that ${review.baseRef} does not already have.`}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {commits.map((commit) => (
            <li key={commit.sha}>
              <CommitCard commit={commit} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CommitCard({ commit }: { commit: GitCommit }) {
  return (
    <Card className="flex items-start gap-3 p-3">
      <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={commit.subject}>
          {commit.subject}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {commit.authorName} committed{' '}
          <span title={absoluteTime(commit.committedAt)}>{relativeTime(commit.committedAt)}</span>
        </p>
      </div>
      <code data-selectable className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">
        {commit.shortSha}
      </code>
    </Card>
  )
}

function LoadingState() {
  return (
    <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading commits">
      {[0, 1, 2].map((index) => (
        <li key={index}>
          <Card className="flex items-start gap-3 p-3">
            <Skeleton className="size-4 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-4 w-16" />
          </Card>
        </li>
      ))}
    </ul>
  )
}
