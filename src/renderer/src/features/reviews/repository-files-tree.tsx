/**
 * Every file in the repository, as something a person can actually find a file
 * in.
 *
 * The changed-files tree next door lists tens of files and can afford to show
 * all of them open. This one lists all of them - twenty thousand in a large
 * checkout - so it has two modes, and which one you are in is decided by
 * whether the filter box has anything in it.
 *
 * **Browsing.** A tree with its directories shut, opened one at a time, plus
 * whatever is already open along the path to the file being read. This is for
 * when you know roughly where you are going, or want to see how the project is
 * laid out.
 *
 * **Filtering.** A flat, ranked list of matches - a fuzzy file finder, the way
 * every editor does it. The ranking is `file-filter.ts` and the row is
 * `MatchedFilePath`: the file's *name* first, in the reader's colour, with its
 * directory dimmed behind it and the characters the query hit marked in both.
 * A result list that leads with the directory puts forty identical characters
 * in front of the only part that distinguishes one row from the next, and the
 * deeper the file the worse it gets - see the note on `MatchedFilePath`.
 */
import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode } from 'lucide-react'
import { cn } from '@/lib/utils'
import { plural } from '@/lib/format'
import { FilterBox } from './filter-box'
import { filterPaths } from './file-filter'
import { FilePath, MatchedFilePath } from './file-path'
import { buildPathTree, type PathNode } from './path-tree'

export interface RepositoryFilesTreeProps {
  paths: string[]
  /** The file currently open, or null before one has been picked. */
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Paths the review's diff contains, so the tree can mark them. */
  changedPaths: ReadonlySet<string>
  /** Unresolved comment count per path. */
  unresolvedByFile: Map<string, number>
}

export function RepositoryFilesTree({
  paths,
  selectedPath,
  onSelect,
  changedPaths,
  unresolvedByFile
}: RepositoryFilesTreeProps) {
  const [query, setQuery] = useState('')
  const tree = useMemo(() => buildPathTree(paths), [paths])

  /**
   * Directories the reader has opened or shut by hand. Absent means "no
   * opinion", which is not the same as shut - see `isOpen` below.
   */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map())

  /**
   * Every directory above the file being read.
   *
   * Derived rather than written into the open set when the selection changes,
   * which is the difference between this and the obvious version. Deriving
   * means arriving on a deep link opens the tree to where you are without an
   * effect that writes state during render - and it means a directory the
   * reader shut *stays* shut even though the current file is inside it, because
   * an explicit decision outranks a default.
   */
  const onPathToSelection = useMemo(() => {
    const ancestors = new Set<string>()
    if (selectedPath === null) return ancestors
    const segments = selectedPath.split('/')
    segments.pop()
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      ancestors.add(prefix)
    }
    return ancestors
  }, [selectedPath])

  const isOpen = useCallback(
    (path: string) => toggled.get(path) ?? onPathToSelection.has(path),
    [toggled, onPathToSelection]
  )

  const toggle = useCallback(
    (path: string, next: boolean) =>
      setToggled((current) => new Map(current).set(path, next)),
    []
  )

  const matches = useMemo(
    () => (query.trim() === '' ? null : filterPaths(paths, query)),
    [paths, query]
  )

  const rowProps = { selectedPath, onSelect, changedPaths, unresolvedByFile }

  return (
    <div className="flex min-h-0 flex-col">
      <FilterBox
        value={query}
        onChange={setQuery}
        placeholder="Filter files"
        label="Filter files in this repository"
      />

      {matches === null ? (
        <nav aria-label="Repository files" className="flex flex-col gap-px py-1 text-xs">
          {tree.map((node) => (
            <TreeRows
              key={node.path}
              node={node}
              depth={0}
              isOpen={isOpen}
              onToggle={toggle}
              {...rowProps}
            />
          ))}
        </nav>
      ) : matches.shown.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">No file matches that.</p>
      ) : (
        <nav aria-label="Matching files" className="flex flex-col gap-px py-1 text-xs">
          {matches.shown.map((match) => (
            <FileRow key={match.path} path={match.path} indices={match.indices} {...rowProps} />
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
  isOpen,
  onToggle,
  ...rowProps
}: {
  node: PathNode
  depth: number
  isOpen: (path: string) => boolean
  onToggle: (path: string, open: boolean) => void
} & Omit<RepositoryFilesTreeProps, 'paths'>) {
  // Indent by nesting depth, but stop growing it before the column runs out of
  // room; a path fifteen directories deep should still show its file name.
  const indent = { paddingLeft: `${Math.min(depth, 6) * 0.75 + 0.25}rem` }

  if (node.kind === 'file') {
    return <FileRow path={node.path} name={node.name} indent={indent} {...rowProps} />
  }

  const open = isOpen(node.path)

  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(node.path, !open)}
        aria-expanded={open}
        style={indent}
        className="flex w-full items-start gap-1 rounded py-1 pr-1 text-left text-muted-foreground hover:bg-muted"
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3 shrink-0" />
        ) : (
          <ChevronRight className="mt-0.5 size-3 shrink-0" />
        )}
        <FilePath path={node.name} emphasizeName={false} className="min-w-0" />
      </button>
      {open &&
        node.children.map((child) => (
          <TreeRows
            key={child.path}
            node={child}
            depth={depth + 1}
            isOpen={isOpen}
            onToggle={onToggle}
            {...rowProps}
          />
        ))}
    </>
  )
}

function FileRow({
  path,
  name,
  indices,
  indent,
  selectedPath,
  onSelect,
  changedPaths,
  unresolvedByFile
}: {
  path: string
  /** Set on a tree row, where the directories are the rows above this one. */
  name?: string
  /** Set on a filter row: which characters of `path` the query hit. */
  indices?: number[]
  indent?: { paddingLeft: string }
} & Omit<RepositoryFilesTreeProps, 'paths'>) {
  const unresolved = unresolvedByFile.get(path) ?? 0
  const isSelected = path === selectedPath
  const isChanged = changedPaths.has(path)

  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      style={indent ?? { paddingLeft: '0.25rem' }}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-1.5 rounded py-1 pr-1 text-left transition-colors',
        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
      )}
      title={isChanged ? `${path} - changed in this review` : path}
    >
      <FileCode
        className={cn(
          'mt-0.5 size-3 shrink-0',
          // The one distinction worth drawing in a list of every file there is:
          // which of them this review is actually about.
          isChanged ? 'text-primary' : 'text-muted-foreground/60'
        )}
      />
      <span
        className={cn(
          'min-w-0 flex-1 break-words font-mono text-[0.6875rem]',
          isChanged && !isSelected && 'text-foreground'
        )}
      >
        {name === undefined ? (
          <MatchedFilePath path={path} indices={indices ?? []} />
        ) : (
          name
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
    </button>
  )
}
