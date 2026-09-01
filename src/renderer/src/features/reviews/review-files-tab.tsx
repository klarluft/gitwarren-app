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
import { useMemo, useState } from 'react'
import { AlertCircle, FileDiff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/format'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { useCommentMutations, useReviewComments } from '../comments/use-comments'
import { CompareErrorCard, NoWorktreeNotice, WorkingTreeBanner } from './compare-notices'
import { DiffSnippet } from './diff-snippet'
import { DiffStat, FileDiffCard, type AnchoredThread } from './diff-view'
import { useReviewDiff } from './use-reviews'
import { findAnchorFile, isInlineAnchor, resolveAnchor } from '@shared/comment-anchors'
import { threadSnippet } from '@shared/comment-snippets'
import type { FileDiff as FileDiffData } from '@shared/git'
import type { CommentThread, Review } from '@shared/schemas'

/**
 * Place every line comment against the diff that is actually on screen.
 *
 * This runs here rather than in the main process on purpose. The reviewer can
 * flip "include uncommitted" at any moment, which produces a genuinely
 * different diff with different line numbers, and a comment resolved against
 * the other one would be pinned to a line the reader is not looking at. Doing
 * it against the rendered diff makes that impossible by construction - and it
 * reuses the same `resolveAnchor` the MCP server runs, so an agent and the
 * screen never disagree about where a comment sits.
 */
function anchorByFile(
  files: FileDiffData[],
  threads: CommentThread[]
): Map<string, AnchoredThread[]> {
  const byFile = new Map<string, AnchoredThread[]>()

  for (const thread of threads) {
    if (!isInlineAnchor(thread)) continue

    const file = findAnchorFile(files, thread.filePath)
    const anchored: AnchoredThread = {
      ...thread,
      anchor: resolveAnchor(file, {
        filePath: thread.filePath,
        side: thread.side,
        line: thread.line,
        anchorText: thread.anchorText
      })
    }

    // Keyed by the file's current path so a thread left before a rename still
    // shows up on the card the reviewer is looking at.
    const key = file?.path ?? thread.filePath
    const existing = byFile.get(key)
    if (existing) existing.push(anchored)
    else byFile.set(key, [anchored])
  }

  return byFile
}

export function ReviewFilesTab({ review }: { review: Review }) {
  const [includeUncommitted, setIncludeUncommitted] = useState(true)
  const { data, error, isLoading, isRefreshing, refresh } = useReviewDiff(
    review.id,
    includeUncommitted
  )
  const { threads } = useReviewComments(review.id)
  const mutations = useCommentMutations(review.id)

  const threadsByFile = useMemo(
    () => anchorByFile(data?.files ?? [], threads),
    [data?.files, threads]
  )

  /** Threads keyed under a path that no file in the current diff carries. */
  const orphanedFiles = useMemo(() => {
    const present = new Set((data?.files ?? []).map((file) => file.path))
    return [...threadsByFile].filter(([path]) => !present.has(path))
  }, [data?.files, threadsByFile])

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

      {/* Threads whose file has left the diff entirely - it was reverted, or
          the base ref moved on and absorbed the change. Nothing below would
          render them, and a discussion that silently disappears because the
          code moved is exactly the failure this app should not have. */}
      {orphanedFiles.length > 0 && (
        <Card className="flex flex-col gap-2 border-warning/40 p-3">
          <p className="text-xs text-muted-foreground">
            {plural(orphanedFiles.length, 'file')} with comments{' '}
            {orphanedFiles.length === 1 ? 'is' : 'are'} no longer in this diff.
          </p>
          {orphanedFiles.map(([path, fileThreads]) => (
            <div key={path} className="flex flex-col gap-3">
              {fileThreads.map((thread) => {
                // No file to read the code from, so this is the stored snapshot
                // or nothing at all.
                const snippet = threadSnippet(thread, thread.anchor, undefined)
                const hasSnippet = snippet !== null && snippet.lines.length > 0

                return (
                  <div key={thread.id} className="flex flex-col gap-2">
                    {hasSnippet ? (
                      <DiffSnippet {...snippet} />
                    ) : (
                      <p className="font-mono text-xs text-muted-foreground">{path}</p>
                    )}
                    <CommentThreadCard
                      thread={thread}
                      mutations={mutations}
                      anchorState={thread.anchor.state}
                      location={
                        !hasSnippet && thread.line !== null ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            was line {thread.line}
                          </span>
                        ) : null
                      }
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </Card>
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
            <FileDiffCard
              key={`${file.oldPath ?? ''}:${file.path}`}
              file={file}
              comments={{
                reviewId: review.id,
                threads: threadsByFile.get(file.path) ?? [],
                mutations
              }}
            />
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
