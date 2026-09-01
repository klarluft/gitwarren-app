/**
 * The list of reviews for one repository, with its loading, empty and error
 * states kept together so it is visible that all of them are handled.
 */
import { useState } from 'react'
import { AlertCircle, ArrowRight, GitPullRequestArrow, Plus, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { absoluteTime, relativeTime } from '@/lib/format'
import { navigate } from '@/lib/router'
import { cn } from '@/lib/utils'
import { ReviewFormDialog } from './review-form-dialog'
import { useReviews } from './use-reviews'
import type { Review, ReviewStatus } from '@shared/schemas'

type Filter = 'all' | ReviewStatus

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' }
]

export function ReviewList({ repositoryId }: { repositoryId: number }) {
  const [filter, setFilter] = useState<Filter>('open')
  const [formOpen, setFormOpen] = useState(false)

  const { data: reviews, error, isLoading, isRefreshing, refresh } = useReviews(
    repositoryId,
    filter === 'all' ? undefined : filter
  )

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                filter === value
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => void refresh()}
            disabled={isLoading}
            title="Reload reviews"
            aria-label="Refresh"
          >
            <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
          </Button>
          <Button onClick={() => setFormOpen(true)}>
            <Plus />
            New review
          </Button>
        </div>
      </header>

      {isLoading && <LoadingState />}

      {!isLoading && error !== undefined && (
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
      )}

      {!isLoading && error === undefined && reviews?.length === 0 && (
        <EmptyState filter={filter} onCreate={() => setFormOpen(true)} />
      )}

      {!isLoading && error === undefined && reviews && reviews.length > 0 && (
        <ul className="flex flex-col gap-2">
          {reviews.map((review) => (
            <li key={review.id}>
              <ReviewCard review={review} />
            </li>
          ))}
        </ul>
      )}

      <ReviewFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        repositoryId={repositoryId}
        onCreated={(review) => navigate({ name: 'review', reviewId: review.id, tab: 'files' })}
      />
    </section>
  )
}

function ReviewCard({ review }: { review: Review }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => navigate({ name: 'review', reviewId: review.id, tab: 'conversation' })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          navigate({ name: 'review', reviewId: review.id, tab: 'conversation' })
        }
      }}
      className="flex cursor-pointer items-center gap-4 p-4 transition-colors hover:border-foreground/20"
    >
      <GitPullRequestArrow
        className={cn(
          'size-4 shrink-0',
          review.status === 'open' ? 'text-success' : 'text-muted-foreground'
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-medium" title={review.title}>
            {review.title}
          </h3>
          {review.status === 'closed' && <Badge variant="outline">Closed</Badge>}
        </div>
        <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
          <span className="truncate">{review.baseRef}</span>
          <ArrowRight className="size-3 shrink-0" />
          <span className="truncate">{review.headRef}</span>
        </p>
      </div>

      <span
        className="shrink-0 text-xs text-muted-foreground"
        title={absoluteTime(review.updatedAt)}
      >
        {relativeTime(review.updatedAt)}
      </span>
    </Card>
  )
}

function LoadingState() {
  return (
    <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading reviews">
      {[0, 1].map((index) => (
        <li key={index}>
          <Card className="flex items-center gap-4 p-4">
            <Skeleton className="size-4 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-3 w-16" />
          </Card>
        </li>
      ))}
    </ul>
  )
}

function EmptyState({ filter, onCreate }: { filter: Filter; onCreate: () => void }) {
  const isFiltered = filter !== 'all'

  return (
    <Card className="flex flex-col items-center gap-3 border-dashed px-6 py-12 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <GitPullRequestArrow className="size-6" />
      </div>
      <div>
        <h3 className="font-medium">
          {filter === 'closed' ? 'No closed reviews' : 'No reviews yet'}
        </h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          {filter === 'closed'
            ? 'Reviews you close are filed here instead of being deleted.'
            : 'Compare two branches to start a review. Work that is only sitting in a worktree, uncommitted, can be reviewed too.'}
        </p>
      </div>
      {filter !== 'closed' && (
        <Button onClick={onCreate} className="mt-1">
          <Plus />
          {isFiltered ? 'New review' : 'Create your first review'}
        </Button>
      )}
    </Card>
  )
}
