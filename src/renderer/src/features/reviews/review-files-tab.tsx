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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, FileDiff, PanelLeft, PanelLeftClose, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/format'
import { useStoredFlag, useStoredPreference } from '@/lib/preferences'
import type { DiffFocus } from '@/lib/router'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { useCommentMutations, useReviewComments } from '../comments/use-comments'
import { ChangedFilesTree } from './changed-files-tree'
import { CompareErrorCard, NoWorktreeNotice, WorkingTreeBanner } from './compare-notices'
import { fileDomId, lineDomId } from './dom-ids'
import { DiffSnippet } from './diff-snippet'
import { DiffStat, FileDiffCard, type AnchoredThread } from './diff-view'
import { useEditors, useReviewDiff } from './use-reviews'
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
        startLine: thread.startLine,
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

/**
 * Which file is nearest the top of the page, so the tree can point at it.
 *
 * An observer rather than a scroll handler: the browser answers "is this on
 * screen" without a layout read per frame, and the top band is narrowed with a
 * negative bottom margin so "current" means the file you are reading rather
 * than the last one that happens to be visible.
 */
function useActiveFile(paths: string[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  const key = paths.join('\n')

  useEffect(() => {
    const order = key === '' ? [] : key.split('\n')
    const visible = new Set<string>()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = entry.target.getAttribute('data-file-path')
          if (path === null) continue
          if (entry.isIntersecting) visible.add(path)
          else visible.delete(path)
        }
        setActive(order.find((path) => visible.has(path)) ?? null)
      },
      { rootMargin: '0px 0px -70% 0px' }
    )

    for (const path of order) {
      const element = document.getElementById(fileDomId(path))
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [key])

  return active
}

/**
 * Scroll to the line the URL asked for, and mark it while the reader finds it.
 *
 * The target may not be in the DOM yet - the diff is still rendering, or the
 * file card is collapsed and about to open - so this retries for a few frames
 * rather than firing once and missing. A line that never appears (the comment
 * was on code this diff does not contain) falls back to the file's card, which
 * is where such a thread is listed.
 */
function useFocusScroll(focus: DiffFocus | undefined, ready: boolean): DiffFocus | null {
  const [marked, setMarked] = useState<DiffFocus | null>(null)
  const key = focus ? `${focus.filePath}:${focus.side}:${focus.line}` : null

  useEffect(() => {
    if (!focus || !ready) return

    let frames = 0
    let frame = 0
    let clear = 0

    const find = (): void => {
      const line = document.getElementById(lineDomId(focus.filePath, focus.side, focus.line))
      const target = line ?? document.getElementById(fileDomId(focus.filePath))

      if (target) {
        target.scrollIntoView({ block: line ? 'center' : 'start', behavior: 'smooth' })
        if (line) {
          setMarked(focus)
          // Long enough to catch the eye after a smooth scroll, short enough
          // that the diff is not left permanently highlighted.
          clear = window.setTimeout(() => setMarked(null), 2500)
        }
        return
      }
      // ~30 frames is half a second of waiting for a card to open.
      if (frames++ < 30) frame = requestAnimationFrame(find)
    }

    frame = requestAnimationFrame(find)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(clear)
      setMarked(null)
    }
    // `key` stands in for the focus object, which is rebuilt on every route read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  return marked
}

export function ReviewFilesTab({ review, focus }: { review: Review; focus?: DiffFocus }) {
  const [includeUncommitted, setIncludeUncommitted] = useState(true)
  const [treeOpen, setTreeOpen] = useStoredFlag('files-tree', true)
  const [editorId, setEditorId] = useStoredPreference('editor', null)
  const [openError, setOpenError] = useState<unknown>(null)
  const { data, error, isLoading, isRefreshing, refresh } = useReviewDiff(
    review.id,
    includeUncommitted
  )
  const { threads } = useReviewComments(review.id)
  const mutations = useCommentMutations(review.id)
  const editors = useEditors()

  const threadsByFile = useMemo(
    () => anchorByFile(data?.files ?? [], threads),
    [data?.files, threads]
  )

  /** Threads keyed under a path that no file in the current diff carries. */
  const orphanedFiles = useMemo(() => {
    const present = new Set((data?.files ?? []).map((file) => file.path))
    return [...threadsByFile].filter(([path]) => !present.has(path))
  }, [data?.files, threadsByFile])

  const paths = useMemo(() => (data?.files ?? []).map((file) => file.path), [data?.files])
  const activePath = useActiveFile(paths)

  /** What the tree shows next to a file: comments still waiting on someone. */
  const unresolvedByFile = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [path, fileThreads] of threadsByFile) {
      const unresolved = fileThreads.filter((thread) => thread.resolvedAt === null).length
      if (unresolved > 0) counts.set(path, unresolved)
    }
    return counts
  }, [threadsByFile])

  const openInEditor = useCallback(
    (path: string, line: number) => {
      setOpenError(null)
      api.reviews
        .openInEditor({
          id: review.id,
          path,
          includeUncommitted,
          line,
          ...(editorId === null ? {} : { editorId })
        })
        .catch(setOpenError)
    },
    [review.id, includeUncommitted, editorId]
  )

  const marked = useFocusScroll(focus, !isLoading && data !== undefined)

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
          {data.files.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTreeOpen(!treeOpen)}
              title={treeOpen ? 'Hide the file list' : 'Show the file list'}
              aria-pressed={treeOpen}
            >
              {treeOpen ? <PanelLeftClose /> : <PanelLeft />}
              Files
            </Button>
          )}

          {/* Only worth asking when the machine actually has a choice. */}
          {editors !== undefined && editors.editors.length > 1 && (
            <Select
              items={editors.editors.map((editor) => ({
                value: editor.id,
                label: editor.label
              }))}
              value={editorId ?? editors.defaultId ?? ''}
              onValueChange={(next) => setEditorId(typeof next === 'string' ? next : null)}
            >
              <SelectTrigger
                className="h-8 w-auto min-w-32 max-w-48 text-xs"
                title="Which editor the open-file buttons use"
              >
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                {editors.editors.map((editor) => (
                  <SelectItem key={editor.id} value={editor.id}>
                    {editor.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

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
        // `items-start` so the tree can stick to the top of the viewport while
        // the diff beside it scrolls; a stretched column would never stick.
        <div className="flex items-start gap-4">
          {treeOpen && (
            <aside className="sticky top-2 max-h-[calc(100vh-6rem)] w-56 shrink-0 overflow-y-auto rounded-lg border border-border bg-card/50 px-1">
              <ChangedFilesTree
                files={data.files}
                activePath={activePath}
                unresolvedByFile={unresolvedByFile}
                onSelect={(path) => {
                  document
                    .getElementById(fileDomId(path))
                    ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                }}
              />
            </aside>
          )}

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {data.files.map((file) => (
              <div
                key={`${file.oldPath ?? ''}:${file.path}`}
                id={fileDomId(file.path)}
                data-file-path={file.path}
                className="scroll-mt-2"
              >
                <FileDiffCard
                  // Remounted when the switch flips: that is a different diff
                  // with different line numbers, so anything unfolded against
                  // the old one has to go.
                  key={includeUncommitted ? 'with-uncommitted' : 'committed-only'}
                  file={file}
                  // Only the card that owns the line hears about it, so one
                  // arriving link cannot light up the same number in every file.
                  focus={focus?.filePath === file.path ? focus : undefined}
                  marked={marked?.filePath === file.path ? marked : undefined}
                  comments={{
                    reviewId: review.id,
                    threads: threadsByFile.get(file.path) ?? [],
                    mutations
                  }}
                  source={{
                    reviewId: review.id,
                    includeUncommitted,
                    editorId,
                    editorLabel:
                      editors?.editors.find(
                        (editor) => editor.id === (editorId ?? editors.defaultId)
                      )?.label ?? null,
                    onOpenInEditor: openInEditor
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {openError !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(openError)}
        </p>
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
