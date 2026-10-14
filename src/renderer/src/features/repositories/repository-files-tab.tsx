/**
 * The repository's own files, with no review in between.
 *
 * A review's Browse tab already reads any file of the repository - but only
 * through a review, at its head, which made "let me just look at the chapter"
 * a matter of inventing a comparison first. This is the same reading without
 * that step: the file tree, the same `FileSourceCard`, the same Markdown
 * preview, pointed at the repository directly.
 *
 * ## Which version of the files
 *
 * By default, whatever the repository's checkout has checked out, read from
 * disk - uncommitted and untracked files included, because that is what "the
 * files in this folder" means to the person who owns the folder. The ref picker
 * reads any branch or tag instead: from the worktree that holds it when there
 * is one, from the commit when there is not. The choice is in the URL with the
 * file, so a link to a chapter on a draft branch opens that chapter on that
 * branch.
 *
 * ## What is deliberately missing
 *
 * Comments. A comment in GitWarren belongs to a review, and this screen has
 * none; a gutter button that had to create one behind the reader's back would
 * be a review nobody asked for. The line gutter therefore has no comment
 * button here, which `LineRow` already does when it is given no comments.
 */
import { useCallback, useMemo } from 'react'
import { AlertCircle, FolderTree, ListTree, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage, isDisconnection } from '@/lib/errors'
import { plural } from '@/lib/format'
import { useHostScope } from '@/lib/host-scope'
import { useNarrow } from '@/lib/narrow'
import { useStoredFlag } from '@/lib/preferences'
import { replace } from '@/lib/router'
import { FileSourceCard } from '@/features/reviews/file-source-view'
import { RefSelect } from '@/features/reviews/ref-select'
import { RepositoryFilesTree } from '@/features/reviews/repository-files-tree'
import { SidebarColumn } from '@/features/reviews/sidebar-column'
import { useRepositoryRefs, useRepositoryTree } from '@/features/reviews/use-reviews'
import type { RepositoryWithGitState } from '@shared/schemas'

const NOTHING_CHANGED: ReadonlySet<string> = new Set()
const NO_COMMENTS = new Map<string, number>()

export function RepositoryFilesTab({
  repository,
  filePath,
  gitRef
}: {
  repository: RepositoryWithGitState
  /** The file open, from the route. */
  filePath?: string
  /** The ref read at, from the route. Undefined is the checkout's own branch. */
  gitRef?: string
}) {
  const scope = useHostScope()
  const narrow = useNarrow()
  const [treeOpen, setTreeOpen] = useStoredFlag('repository-files-tree', true)
  const ref = gitRef ?? null
  const tree = useRepositoryTree(repository.id, ref)
  const refs = useRepositoryRefs(repository.id)

  const selectedPath = filePath ?? null

  /** A move within this tab, keeping whatever was not changed. */
  const go = useCallback(
    (to: { filePath?: string | null; ref?: string | null }) => {
      const nextPath = to.filePath === undefined ? filePath : (to.filePath ?? undefined)
      const nextRef = to.ref === undefined ? gitRef : (to.ref ?? undefined)
      replace({
        name: 'repository',
        repositoryId: repository.id,
        tab: 'files',
        ...(nextPath === undefined ? {} : { filePath: nextPath }),
        ...(nextRef === undefined ? {} : { ref: nextRef }),
        ...scope
      })
    },
    [repository.id, filePath, gitRef, scope]
  )

  const selectFile = useCallback((path: string) => go({ filePath: path }), [go])

  const source = useMemo(
    () => ({ kind: 'repository' as const, repositoryId: repository.id, ref }),
    [repository.id, ref]
  )

  const checkedOut = repository.git.branch
  const shownRef = ref ?? checkedOut ?? 'HEAD'
  const paths = tree.data?.paths ?? []
  const listOpen = narrow ? selectedPath === null || treeOpen : treeOpen

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setTreeOpen(!treeOpen)} aria-expanded={listOpen}>
          {listOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          {listOpen ? 'Hide files' : 'Show files'}
        </Button>

        {/* Choosing the branch that is checked out is choosing the default:
            the route drops the ref, so the link stays the plain one. */}
        <div className="w-56 max-w-full">
          <RefSelect
            id={`repository-${repository.id}-ref`}
            refs={refs.data?.refs ?? []}
            value={shownRef}
            onChange={(next) => go({ ref: next === checkedOut ? null : next })}
            disabled={refs.data === undefined}
          />
        </div>

        {tree.data !== undefined && (
          <p className="text-xs text-muted-foreground">
            {plural(paths.length, 'file')}
            {tree.data.truncated && ' (listing cut short)'}
          </p>
        )}
        {tree.data?.source === 'worktree' && (
          <Badge variant="outline" title="Read from the files on disk, including work that is not committed yet.">
            on disk
          </Badge>
        )}
        {tree.data?.source === 'commit' && (
          <Badge variant="outline" title="No worktree has this checked out, so the files are read from the commit.">
            committed
          </Badge>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => void tree.refresh()}
          title="Re-read the file list from disk"
        >
          <RefreshCw className={tree.isRefreshing ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      {tree.isLoading && tree.data === undefined ? (
        <Skeleton className="h-64 w-full" />
      ) : tree.error !== undefined ? (
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
      ) : (
        <>
          {tree.data?.error !== null && tree.data?.error !== undefined && (
            <Card className="flex items-start gap-3 border-warning/40 p-3 text-xs">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>{tree.data.error}</p>
            </Card>
          )}

          {/* `items-start` so the tree can stick while the file scrolls. */}
          <div className="flex items-start gap-4">
            {listOpen && (
              <SidebarColumn storageKey="repository-files-tree-width" narrow={narrow} label="the file list">
                <RepositoryFilesTree
                  paths={paths}
                  selectedPath={selectedPath}
                  onSelect={selectFile}
                  changedPaths={NOTHING_CHANGED}
                  unresolvedByFile={NO_COMMENTS}
                />
              </SidebarColumn>
            )}

            {(!narrow || !listOpen) && (
              <div className="min-w-0 flex-1">
                {selectedPath === null ? (
                  <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
                    <div className="rounded-full bg-muted p-3 text-muted-foreground">
                      <FolderTree className="size-6" />
                    </div>
                    <h3 className="font-medium">Pick a file</h3>
                    <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                      Every file in the repository at <span className="font-mono">{shownRef}</span>.
                      Markdown files can be read rendered. To comment on a file, open it from a
                      review’s Browse tab.
                    </p>
                  </Card>
                ) : (
                  <FileSourceCard
                    // A different file, or the same file at another ref, is a
                    // different document.
                    key={`${ref ?? ''}:${selectedPath}`}
                    source={source}
                    path={selectedPath}
                    isChanged={false}
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
        </>
      )}
    </div>
  )
}
