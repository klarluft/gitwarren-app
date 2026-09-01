/**
 * The review screen: a header describing the comparison, and the three tabs.
 *
 * The commit read is issued here rather than only inside the commits tab. It is
 * cheap (`git log` plus a `git status` in the head worktree), it is shared with
 * the tab through SWR's cache under the same key, and it is what lets the
 * header say "this branch has uncommitted work" no matter which tab you land
 * on - which is the single most useful thing this app can tell you on arrival.
 * The diff stays lazy, because that one is not cheap.
 */
import { useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CircleDot,
  GitPullRequestArrow,
  MessageSquare,
  Pencil,
  Trash2
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsCount, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { errorMessage } from '@/lib/errors'
import { navigate, replace, type ReviewTab } from '@/lib/router'
import { ReviewCommitsTab } from './review-commits-tab'
import { ReviewConversationTab } from './review-conversation-tab'
import { ReviewFilesTab } from './review-files-tab'
import { ReviewFormDialog } from './review-form-dialog'
import { RemoveReviewDialog } from './remove-review-dialog'
import { useReview, useReviewCommits, useReviewMutations } from './use-reviews'
import type { Review } from '@shared/schemas'

interface ReviewDetailProps {
  reviewId: number
  tab: ReviewTab
}

export function ReviewDetail({ reviewId, tab }: ReviewDetailProps) {
  const { data: review, error, isLoading } = useReview(reviewId)
  const { updateReview } = useReviewMutations()
  const commits = useReviewCommits(reviewId)

  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState<Review | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<unknown>(null)

  if (isLoading) return <LoadingState />

  if (error !== undefined || !review) {
    return (
      <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-12 text-center">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <div>
          <h3 className="font-medium">Review not found</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {error === undefined ? 'It may have been deleted.' : errorMessage(error)}
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate({ name: 'repositories' })}>
          <ArrowLeft />
          Back to repositories
        </Button>
      </Card>
    )
  }

  const workingTree = commits.data?.workingTree ?? null
  const isOpen = review.status === 'open'

  async function toggleStatus(): Promise<void> {
    if (!review) return
    setStatusBusy(true)
    setStatusError(null)
    try {
      await updateReview({ id: review.id, status: isOpen ? 'closed' : 'open' })
    } catch (caught) {
      setStatusError(caught)
    } finally {
      setStatusBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 text-muted-foreground"
          onClick={() => navigate({ name: 'repository', repositoryId: review.repositoryId })}
        >
          <ArrowLeft />
          {review.repository.name}
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitPullRequestArrow
                className={`size-5 shrink-0 ${isOpen ? 'text-success' : 'text-muted-foreground'}`}
              />
              <h1 className="truncate text-xl font-semibold tracking-tight" title={review.title}>
                {review.title}
              </h1>
              <Badge variant={isOpen ? 'success' : 'outline'}>{isOpen ? 'Open' : 'Closed'}</Badge>
            </div>

            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <span className="rounded bg-muted px-1.5 py-0.5">{review.baseRef}</span>
              <ArrowRight className="size-3" />
              <span className="rounded bg-muted px-1.5 py-0.5">{review.headRef}</span>
              {workingTree?.isDirty && (
                <Badge
                  variant="warning"
                  className="ml-1"
                  title={`Uncommitted changes in ${workingTree.worktreePath}`}
                >
                  <CircleDot />
                  uncommitted work
                </Badge>
              )}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={statusBusy}
              onClick={() => void toggleStatus()}
            >
              {isOpen ? 'Close review' : 'Reopen'}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive"
              title="Delete review"
              aria-label="Delete review"
              onClick={() => setRemoving(review)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </div>

      {statusError !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(statusError)}
        </p>
      )}

      <Tabs
        value={tab}
        onValueChange={(next) =>
          replace({ name: 'review', reviewId, tab: next as ReviewTab })
        }
      >
        <TabsList>
          <TabsTab value="conversation">
            <MessageSquare />
            Conversation
          </TabsTab>
          <TabsTab value="commits">
            Commits
            {commits.data && <TabsCount>{commits.data.commits.length}</TabsCount>}
          </TabsTab>
          <TabsTab value="files">Files changed</TabsTab>
        </TabsList>

        <TabsPanel value="conversation">
          <ReviewConversationTab review={review} onEdit={() => setEditing(true)} />
        </TabsPanel>
        <TabsPanel value="commits">
          <ReviewCommitsTab review={review} />
        </TabsPanel>
        <TabsPanel value="files">
          <ReviewFilesTab review={review} />
        </TabsPanel>
      </Tabs>

      <ReviewFormDialog
        open={editing}
        onOpenChange={setEditing}
        repositoryId={review.repositoryId}
        review={review}
      />
      <RemoveReviewDialog
        review={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        onRemoved={() => navigate({ name: 'repository', repositoryId: review.repositoryId })}
      />
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading review">
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-6 w-72" />
        <Skeleton className="h-4 w-52" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
