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
import { useCallback, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CircleDot,
  FileDiff,
  GitCommitHorizontal,
  GitPullRequestArrow,
  MessageSquare,
  Pencil,
  Trash2
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsCount, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { errorMessage } from '@/lib/errors'
import { useRegisterCommands, type Command } from '@/features/commands/command-registry'
import { navigate, replace, REVIEW_TABS, type DiffFocus, type ReviewTab } from '@/lib/router'
import { useReviewComments } from '../comments/use-comments'
import { ReviewCommitsTab } from './review-commits-tab'
import { ReviewConversationTab } from './review-conversation-tab'
import { ReviewFilesTab } from './review-files-tab'
import { ReviewFormDialog } from './review-form-dialog'
import { RemoveReviewDialog } from './remove-review-dialog'
import { useReview, useReviewCommits, useReviewMutations } from './use-reviews'
import type { Review } from '@shared/schemas'

/** Tab labels and icons, shared by the tab strip's commands and the strip. */
const TAB_LABELS: Record<ReviewTab, string> = {
  conversation: 'Conversation',
  commits: 'Commits',
  files: 'Files changed'
}

const TAB_ICONS: Record<ReviewTab, typeof MessageSquare> = {
  conversation: MessageSquare,
  commits: GitCommitHorizontal,
  files: FileDiff
}

interface ReviewDetailProps {
  reviewId: number
  tab: ReviewTab
  /** A line of the diff to scroll to, when arriving from a conversation thread. */
  focus?: DiffFocus
}

export function ReviewDetail({ reviewId, tab, focus }: ReviewDetailProps) {
  const { data: review, error, isLoading } = useReview(reviewId)
  const { updateReview } = useReviewMutations()
  const commits = useReviewCommits(reviewId)
  // Read here rather than inside the tab so the count is on the tab itself.
  // It is one indexed query and it is polled, which matters because agents
  // write into this review from their own processes while it is open.
  const { threads } = useReviewComments(reviewId)

  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState<Review | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<unknown>(null)

  const toggleStatus = useCallback(async (): Promise<void> => {
    if (!review) return
    setStatusBusy(true)
    setStatusError(null)
    try {
      await updateReview({ id: review.id, status: review.status === 'open' ? 'closed' : 'open' })
    } catch (caught) {
      setStatusError(caught)
    } finally {
      setStatusBusy(false)
    }
  }, [review, updateReview])

  useRegisterCommands(
    useMemo<Command[]>(
      () =>
        review === undefined
          ? []
          : [
              // The digits match the tabs left to right. `replace` rather than
              // `navigate` for the same reason the tab strip uses it: back
              // should leave the review, not walk the tabs on the way out.
              ...REVIEW_TABS.map(
                (name, index): Command => ({
                  id: `review:tab:${name}`,
                  label: TAB_LABELS[name],
                  group: 'Review',
                  keys: String(index + 1),
                  keywords: 'tab',
                  icon: TAB_ICONS[name],
                  disabled: tab === name,
                  run: () => replace({ name: 'review', reviewId, tab: name })
                })
              ),
              {
                id: 'review:edit',
                label: 'Edit review',
                group: 'Review',
                keys: 'e',
                keywords: 'title description base head ref rename',
                icon: Pencil,
                run: () => setEditing(true)
              },
              {
                id: 'review:status',
                label: review.status === 'open' ? 'Close review' : 'Reopen review',
                group: 'Review',
                // No key on purpose: changing a review's status is a decision,
                // not navigation, and a bare letter is too easy to lean on.
                keywords: 'close reopen resolve finish status',
                icon: GitPullRequestArrow,
                disabled: statusBusy,
                run: () => void toggleStatus()
              },
              {
                id: 'review:repository',
                label: `Go to ${review.repository.name}`,
                group: 'Navigate',
                keys: 'g r',
                keywords: 'repository parent',
                icon: ArrowLeft,
                run: () => navigate({ name: 'repository', repositoryId: review.repositoryId })
              },
              {
                id: 'review:remove',
                label: 'Delete review',
                group: 'Review',
                keywords: 'remove destroy',
                icon: Trash2,
                // Also keyless: it opens a confirmation, but a shortcut that
                // starts a deletion is a shortcut someone will hit by accident.
                run: () => setRemoving(review)
              }
            ],
      [review, reviewId, tab, statusBusy, toggleStatus]
    )
  )

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
  const unresolvedThreads = threads.filter((thread) => thread.resolvedAt === null).length

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
            <Tooltip label="Delete this review">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete review"
                onClick={() => setRemoving(review)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
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
          // No focus: clicking a tab is a fresh arrival, not a jump to a line
          // someone asked for a moment ago.
          replace({ name: 'review', reviewId, tab: next as ReviewTab })
        }
      >
        <TabsList>
          <TabsTab value="conversation">
            <MessageSquare />
            Conversation
            {/* Unresolved rather than total: the number that should make you
                click is how much is still open, not how much was ever said. */}
            {unresolvedThreads > 0 && <TabsCount>{unresolvedThreads}</TabsCount>}
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
          <ReviewFilesTab review={review} focus={focus} />
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
