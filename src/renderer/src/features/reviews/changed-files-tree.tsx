/**
 * The list of changed files beside the diff.
 *
 * The folding into a tree is `path-tree.ts`, the filter above it is
 * `file-filter.ts`, and both are shared with the browse tab's listing of the
 * whole repository. What is here is what a *changed* file's row says: how much
 * changed, whether anyone commented, whether it has been read.
 *
 * The tree is a *navigation* aid, not a second copy of the diff: it scrolls the
 * page to a file, and it says how much changed and whether anyone commented.
 * Everything else stays in the file card.
 *
 * ## Why this has a filter box too
 *
 * A twelve-file branch does not need one. A branch that renames a symbol across
 * two hundred files does, and by then the tree is a column you scroll rather
 * than a list you read. Giving it the browse tab's filter - the same box, the
 * same ranking, the same name-first result row - means the gesture that finds a
 * file is one gesture in this app rather than one per tab.
 */
import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { plural } from '@/lib/format'
import { FileStatusIcon } from './diff-view'
import { filterPaths } from './file-filter'
import { FilePath, MatchedFilePath } from './file-path'
import { FilterBox } from './filter-box'
import { buildPathTree, type PathNode } from './path-tree'
import type { FileDiff } from '@shared/git'

export interface ChangedFilesTreeProps {
  files: FileDiff[]
  /** Path of the file currently nearest the top of the page. */
  activePath: string | null
  onSelect: (path: string) => void
  /** Unresolved comment count per file path. */
  unresolvedByFile: Map<string, number>
  /** Files ticked off against the version currently on screen. */
  reviewedPaths: ReadonlySet<string>
  /** Files ticked off against an older version of themselves. */
  changedSincePaths: ReadonlySet<string>
}

/**
 * How many changed files it takes before the filter box appears.
 *
 * Roughly a screenful. Below it scrolling is not yet the way you find a row,
 * and a control that can only hide things the reader can already see is a
 * control that earns nothing.
 */
const FILTER_FROM = 15

export function ChangedFilesTree({ files, ...rowProps }: ChangedFilesTreeProps) {
  const [query, setQuery] = useState('')
  const paths = useMemo(() => files.map((file) => file.path), [files])
  const tree = useMemo(() => buildPathTree(paths), [paths])
  // What each row needs about its own file, looked up by path - see `path-tree.ts`.
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])

  const matches = useMemo(
    () => (query.trim() === '' ? null : filterPaths(paths, query)),
    [paths, query]
  )

  return (
    <div className="flex min-h-0 flex-col">
      {files.length >= FILTER_FROM && (
        <FilterBox
          value={query}
          onChange={setQuery}
          placeholder="Filter changed files"
          label="Filter the files this review changed"
        />
      )}

      {matches === null ? (
        <nav aria-label="Changed files" className="flex flex-col gap-px py-1 text-xs">
          {tree.map((node) => (
            <TreeRows key={node.path} node={node} depth={0} byPath={byPath} {...rowProps} />
          ))}
        </nav>
      ) : matches.shown.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          No changed file matches that.
        </p>
      ) : (
        <nav aria-label="Matching changed files" className="flex flex-col gap-px py-1 text-xs">
          {matches.shown.map((match) => (
            <FileRow
              key={match.path}
              file={byPath.get(match.path) as FileDiff}
              indices={match.indices}
              {...rowProps}
            />
          ))}
          {matches.total > matches.shown.length && (
            <p className="px-3 py-2 text-[0.6875rem] text-muted-foreground">
              {plural(matches.total - matches.shown.length, 'more match', 'more matches')}. Keep
              typing to narrow it.
            </p>
          )}
        </nav>
      )}
    </div>
  )
}

function TreeRows({
  node,
  depth,
  byPath,
  ...rowProps
}: {
  node: PathNode
  depth: number
  byPath: Map<string, FileDiff>
} & Omit<ChangedFilesTreeProps, 'files'>) {
  const [open, setOpen] = useState(true)
  // Indent by nesting depth, but stop growing it before the column runs out of
  // room; a path fifteen directories deep should still show its file name.
  const indent = { paddingLeft: `${Math.min(depth, 6) * 0.75 + 0.25}rem` }

  if (node.kind === 'directory') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          style={indent}
          className="flex w-full items-start gap-1 rounded py-1 pr-1 text-left text-muted-foreground hover:bg-muted"
        >
          {open ? (
            <ChevronDown className="mt-0.5 size-3 shrink-0" />
          ) : (
            <ChevronRight className="mt-0.5 size-3 shrink-0" />
          )}
          {/* Wraps rather than truncates, like every other path in the app:
              a folded chain of directories is often longer than the column. */}
          <FilePath path={node.name} emphasizeName={false} className="min-w-0" />
        </button>
        {open &&
          node.children.map((child) => (
            <TreeRows
              key={child.path}
              node={child}
              depth={depth + 1}
              byPath={byPath}
              {...rowProps}
            />
          ))}
      </>
    )
  }

  // Always present: the tree was built from these very paths.
  return <FileRow file={byPath.get(node.path) as FileDiff} indent={indent} {...rowProps} />
}

function FileRow({
  file,
  indices,
  indent,
  activePath,
  onSelect,
  unresolvedByFile,
  reviewedPaths,
  changedSincePaths
}: {
  file: FileDiff
  /** Set on a filter row: which characters of the path the query hit. */
  indices?: number[]
  /** Set on a tree row, where the depth is what the indent is measuring. */
  indent?: { paddingLeft: string }
} & Omit<ChangedFilesTreeProps, 'files'>) {
  const path = file.path
  const unresolved = unresolvedByFile.get(path) ?? 0
  const isActive = path === activePath
  const isReviewed = reviewedPaths.has(path)
  const hasChangedSince = changedSincePaths.has(path)

  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      style={indent ?? { paddingLeft: '0.25rem' }}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-1.5 rounded py-1 pr-1 text-left transition-colors',
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        // Read files stay legible but recede, so what is left to do stands out.
        isReviewed && !isActive && 'text-muted-foreground'
      )}
      title={
        hasChangedSince
          ? `${path} - changed since you reviewed it`
          : isReviewed
            ? `${path} - reviewed`
            : path
      }
    >
      {isReviewed ? (
        <Check className="mt-0.5 size-3 shrink-0 text-success" />
      ) : hasChangedSince ? (
        <History className="mt-0.5 size-3 shrink-0 text-warning" />
      ) : (
        <FileStatusIcon status={file.status} className="mt-0.5 size-3 shrink-0" />
      )}
      {/* The whole name, wrapped if it has to be. A file list that cannot tell
          you which file a row is is not doing the one job it has. */}
      <span className="min-w-0 flex-1 break-words font-mono text-[0.6875rem]">
        {indices === undefined ? (
          path.slice(path.lastIndexOf('/') + 1)
        ) : (
          <MatchedFilePath path={path} indices={indices} />
        )}
      </span>
      {unresolved > 0 && (
        <span
          className="shrink-0 rounded-full bg-primary px-1 text-[0.5625rem] font-semibold leading-4 text-primary-foreground"
          title={`${unresolved} unresolved`}
        >
          {unresolved}
        </span>
      )}
      {!file.isBinary && (
        <span className="mt-px shrink-0 font-mono text-[0.625rem] tabular-nums">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      )}
    </button>
  )
}
