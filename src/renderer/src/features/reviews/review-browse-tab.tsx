/**
 * The browse tab: the repository the review is against, one file at a time.
 *
 * Files changed answers "what did this branch do". This answers the question
 * that keeps coming after it - "what does the thing it did that *to* look
 * like" - and it exists because reviewing a change frequently means reading
 * code the change did not touch: the caller of the function that was edited,
 * the test that was not updated, the interface a new field should have gone on.
 * Until now the only way to do that was to leave GitWarren, which also meant
 * that anything you noticed over there had nowhere to be written down.
 *
 * So the point of the tab is not really browsing. It is that a comment can be
 * left on any line of any file, and it lands in the same review, in the same
 * discussion, anchored by the same rules (`shared/comment-anchors.ts`) as a
 * comment on the diff.
 *
 * ## One file, and it is in the URL
 *
 * Files changed stacks every changed file down one page, which is right for a
 * patch of twelve files and impossible for a repository of twelve thousand. So
 * this shows one, and which one is part of the location -
 * `#/reviews/4/browse/src%2Fapp.ts` - rather than component state. That is the
 * same decision `DiffFocus` made for arriving at a line: a file being read is a
 * place, it survives a reload, and it is a link somebody can paste to a
 * colleague or an agent can write into a comment.
 *
 * `replace` rather than `navigate` when a file is picked, matching the tab
 * strip. Clicking through fifteen files should not put fifteen entries between
 * the reviewer and the way out.
 *
 * ## Which version of the files
 *
 * Always the review's own head, read the way the diff's default reads it - the
 * worktree when one holds the head branch, the head commit otherwise. There is
 * deliberately no committed/uncommitted control here to match the one in Files
 * changed. That control answers "which changes am I reviewing", and this tab is
 * not showing changes; a third meaning for it would be a third thing to get
 * wrong, and reading the branch as it actually stands on disk is the only
 * answer anybody wants from a file browser.
 */
import { useCallback, useMemo } from 'react'
import { AlertCircle, FolderTree, ListTree, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage, isDisconnection } from '@/lib/errors'
import { plural } from '@/lib/format'
import { useHost, useApi } from '@/lib/host-scope'
import { useHostScope } from '@/lib/host-scope'
import { useNarrow } from '@/lib/narrow'
import { useStoredFlag, useStoredPreference } from '@/lib/preferences'
import { replace, type DiffFocus } from '@/lib/router'
import { cn } from '@/lib/utils'
import { useCommentMutations, useReviewComments } from '../comments/use-comments'
import { FileSourceCard } from './file-source-view'
import { RepositoryFilesTree } from './repository-files-tree'
import { DEFAULT_DIFF_CHANGES, useEditors, useReviewDiff, useReviewTree } from './use-reviews'
import { isInlineAnchor } from '@shared/comment-anchors'
import { remotelyOpenable } from '@shared/editors'
import type { Review } from '@shared/schemas'

export function ReviewBrowseTab({ review, focus }: { review: Review; focus?: DiffFocus }) {
  const api = useApi()
  const host = useHost()
  const scope = useHostScope()
  const narrow = useNarrow()
  const [treeOpen, setTreeOpen] = useStoredFlag('browse-tree', true)
  const [editorId] = useStoredPreference('editor', null)

  const changes = DEFAULT_DIFF_CHANGES
  const tree = useReviewTree(review.id, changes)
  // Already in the cache: the review screen starts this read at mount, and the
  // files tab subscribes to the same key. What is wanted here is only which
  // paths it covers, so the tree can mark them.
  const diff = useReviewDiff(review.id, changes)
  const { threads } = useReviewComments(review.id)
  const mutations = useCommentMutations()
  const localEditors = useEditors()

  const selectedPath = focus?.filePath ?? null

  const selectFile = useCallback(
    (path: string) => {
      replace({ name: 'review', reviewId: review.id, tab: 'browse', focus: { filePath: path }, ...scope })
    },
    [review.id, scope]
  )

  const changedPaths = useMemo(
    () => new Set((diff.data?.files ?? []).map((file) => file.path)),
    [diff.data?.files]
  )

  /** Line threads by the path they were left on, wherever that path is. */
  const threadsByFile = useMemo(() => {
    const byFile = new Map<string, typeof threads>()
    for (const thread of threads) {
      if (!isInlineAnchor(thread)) continue
      const existing = byFile.get(thread.filePath)
      if (existing) existing.push(thread)
      else byFile.set(thread.filePath, [thread])
    }
    return byFile
  }, [threads])

  const unresolvedByFile = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [path, fileThreads] of threadsByFile) {
      const open = fileThreads.filter((thread) => thread.resolvedAt === null).length
      if (open > 0) counts.set(path, open)
    }
    return counts
  }, [threadsByFile])

  /**
   * The editors on *this* machine that can open a file on *that* one - the same
   * two questions the files tab asks, and the same answer for the same reason.
   * See the long note in `review-files-tab.tsx`.
   */
  const editors = useMemo(
    () => (host === undefined || localEditors === undefined ? localEditors : remotelyOpenable(localEditors)),
    [host, localEditors]
  )

  const openOnItsHost = useCallback(
    (path: string, line: number) => {
      void api.reviews
        .openInEditor({ id: review.id, path, changes, line, ...(editorId === null ? {} : { editorId }) })
        .catch(() => undefined)
    },
    [api, review.id, changes, editorId]
  )

  const openInEditor =
    host !== undefined && editors !== undefined && editors.editors.length === 0
      ? undefined
      : openOnItsHost

  if (tree.isLoading && tree.data === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (tree.error !== undefined) {
    return (
      <Card className="flex items-start gap-3 border-destructive/40 p-4">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">
            {isDisconnection(tree.error)
              ? 'That machine is not answering.'
              : 'The repository could not be listed.'}
          </p>
          <p className="text-xs text-muted-foreground">{errorMessage(tree.error)}</p>
        </div>
      </Card>
    )
  }

  const paths = tree.data?.paths ?? []
  const listOpen = narrow ? selectedPath === null || treeOpen : treeOpen

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTreeOpen(!treeOpen)}
          aria-expanded={listOpen}
        >
          {listOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          {listOpen ? 'Hide files' : 'Show files'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {plural(paths.length, 'file')} at <span className="font-mono">{review.headRef}</span>
          {tree.data?.truncated === true && ' (listing cut short)'}
        </p>
      </div>

      {tree.data?.error !== null && tree.data?.error !== undefined && (
        <Card className="flex items-start gap-3 border-warning/40 p-3 text-xs">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>{tree.data.error}</p>
        </Card>
      )}

      {/* `items-start` so the tree can stick to the top of the viewport while
          the file beside it scrolls; a stretched column would never stick. */}
      <div className="flex items-start gap-4">
        {listOpen && (
          <aside
            className={cn(
              'rounded-lg border border-border bg-card/50',
              narrow
                ? 'w-full'
                : 'sticky top-2 max-h-[calc(100dvh-6rem)] w-56 shrink-0 overflow-y-auto xl:w-64 2xl:w-72'
            )}
          >
            <RepositoryFilesTree
              paths={paths}
              selectedPath={selectedPath}
              onSelect={selectFile}
              changedPaths={changedPaths}
              unresolvedByFile={unresolvedByFile}
            />
          </aside>
        )}

        {/* On a narrow window the list is the screen *instead of* the file, so
            the two never share the width. Same tree, two layouts - the rule the
            files tab settled on. */}
        {(!narrow || !listOpen) && (
          <div className="min-w-0 flex-1">
            {selectedPath === null ? (
              <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
                <div className="rounded-full bg-muted p-3 text-muted-foreground">
                  <FolderTree className="size-6" />
                </div>
                <h3 className="font-medium">Pick a file</h3>
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                  Every file in the repository is here, not only the ones this branch changed. Open
                  one to read it — and to comment on any line of it, in this review.
                </p>
              </Card>
            ) : (
              <FileSourceCard
                // Remounted per file: a different file is a different document,
                // and nothing the reader unfolded or half-typed about the last
                // one belongs to this one.
                key={selectedPath}
                reviewId={review.id}
                path={selectedPath}
                changes={changes}
                threads={threadsByFile.get(selectedPath) ?? []}
                comments={{ reviewId: review.id, mutations, changes }}
                isChanged={changedPaths.has(selectedPath)}
                marked={
                  focus?.side !== undefined && focus.line !== undefined
                    ? { side: focus.side, line: focus.line }
                    : undefined
                }
                editorLabel={editors?.editors.find((editor) => editor.id === editorId)?.label ?? null}
                onOpenInEditor={openInEditor}
              />
            )}
          </div>
        )}
      </div>

      {narrow && listOpen && selectedPath !== null && (
        <Button variant="outline" size="sm" onClick={() => setTreeOpen(false)}>
          <ListTree />
          Back to {selectedPath.slice(selectedPath.lastIndexOf('/') + 1)}
        </Button>
      )}
    </div>
  )
}
