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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
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
  /**
   * Keep the highlighted row in view as the diff scrolls. Only where the tree
   * scrolls on its own, beside the diff: on the narrow layout it scrolls with
   * the page, and following there would move the page itself.
   */
  follow?: boolean
}

/**
 * How many changed files it takes before the filter box appears.
 *
 * Roughly a screenful. Below it scrolling is not yet the way you find a row,
 * and a control that can only hide things the reader can already see is a
 * control that earns nothing.
 */
const FILTER_FROM = 15

/**
 * How long a click on a row keeps the tree from following, at most.
 *
 * Longer than the smooth scroll a click starts. It is only a backstop for a
 * file that never becomes the active one - the last file of a short diff, which
 * cannot scroll up to the top - so that the hold does not outlive its scroll.
 */
const CLICK_HOLD_MS = 1500

/** The nearest ancestor that scrolls - the sidebar the tree sits in. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

/**
 * Scrolls the tree so the highlighted row stays on screen as the diff scrolls.
 *
 * A long branch makes the tree a column taller than the window, and reading the
 * diff file by file walks the highlight off the bottom of it. So whenever the
 * active row leaves the visible part of the tree, the tree brings it back - to
 * the middle rather than the nearest edge, so the files coming next are on
 * screen too and the tree moves once every half a column rather than on every
 * file. A row already in view is left alone: the tree never moves under a
 * reader who can already see where they are.
 *
 * It scrolls the tree's own column and nothing else. `scrollIntoView` would
 * scroll every ancestor too, and drag the diff along with it.
 *
 * A click on a row is the exception. The smooth scroll it starts passes every
 * file between here and there, and following each of them would carry the row
 * just clicked out from under the pointer. So a click holds the tree still
 * until the clicked file becomes the active one, which is in view already.
 *
 * `rendered` is not read - it is whatever changes which rows exist (the
 * filter), so the row is looked for again once it may have come back.
 */
function useFollowActiveRow(
  root: RefObject<HTMLElement | null>,
  activePath: string | null,
  enabled: boolean,
  rendered: unknown
): (path: string) => void {
  const held = useRef<{ path: string; until: number } | null>(null)

  useEffect(() => {
    if (!enabled || activePath === null || root.current === null) return
    const hold = held.current
    if (hold !== null) {
      if (hold.path === activePath) {
        held.current = null
        return
      }
      if (Date.now() <= hold.until) return
      held.current = null
    }

    // Missing when its directory is folded or a filter hides it, and then
    // there is no row to bring into view.
    const row = root.current.querySelector<HTMLElement>('[aria-current="true"]')
    const scroller = row === null ? null : scrollParent(row)
    if (row === null || scroller === null) return

    // The filter box, when there is one, sticks to the top of the column and
    // covers whatever row is scrolled under it, so the visible part starts
    // below it.
    const view = scroller.getBoundingClientRect()
    const cover = row.closest('nav')?.previousElementSibling?.getBoundingClientRect()
    const top = Math.max(view.top, cover?.bottom ?? view.top)
    const box = row.getBoundingClientRect()
    if (box.top >= top && box.bottom <= view.bottom) return

    const middle = top + (view.bottom - top - box.height) / 2
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + box.top - middle),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    })
  }, [root, activePath, enabled, rendered])

  return useCallback((path: string) => {
    held.current = { path, until: Date.now() + CLICK_HOLD_MS }
  }, [])
}

export function ChangedFilesTree({
  files,
  follow = false,
  onSelect,
  ...rest
}: ChangedFilesTreeProps) {
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const paths = useMemo(() => files.map((file) => file.path), [files])
  const tree = useMemo(() => buildPathTree(paths), [paths])
  // What each row needs about its own file, looked up by path - see `path-tree.ts`.
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])

  const matches = useMemo(
    () => (query.trim() === '' ? null : filterPaths(paths, query)),
    [paths, query]
  )

  const holdFollow = useFollowActiveRow(rootRef, rest.activePath, follow, matches)
  const select = useCallback(
    (path: string) => {
      holdFollow(path)
      onSelect(path)
    },
    [holdFollow, onSelect]
  )
  const rowProps = { ...rest, onSelect: select }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-col">
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
              {...rowState(match.path, rowProps)}
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
} & Omit<ChangedFilesTreeProps, 'files' | 'follow'>) {
  const [open, setOpen] = useState(true)
  // Indent by nesting depth, but stop growing it before the column runs out of
  // room; a path fifteen directories deep should still show its file name.
  const paddingLeft = `${Math.min(depth, 6) * 0.75 + 0.25}rem`
  const indent = { paddingLeft }

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
  return (
    <FileRow
      file={byPath.get(node.path) as FileDiff}
      paddingLeft={paddingLeft}
      {...rowState(node.path, rowProps)}
    />
  )
}

/**
 * What one row needs to know, boiled down to values that compare equal when
 * nothing about that row changed - which is what lets `FileRow` skip the
 * re-render. Scrolling onto a new file moves the highlight between two rows,
 * and on a branch of four hundred files the other three hundred and ninety-eight
 * have no reason to be drawn again.
 */
function rowState(path: string, props: Omit<ChangedFilesTreeProps, 'files' | 'follow'>) {
  return {
    isActive: path === props.activePath,
    isReviewed: props.reviewedPaths.has(path),
    hasChangedSince: props.changedSincePaths.has(path),
    unresolved: props.unresolvedByFile.get(path) ?? 0,
    onSelect: props.onSelect
  }
}

const FileRow = memo(function FileRow({
  file,
  indices,
  paddingLeft,
  isActive,
  isReviewed,
  hasChangedSince,
  unresolved,
  onSelect
}: {
  file: FileDiff
  /** Set on a filter row: which characters of the path the query hit. */
  indices?: number[]
  /** Set on a tree row, where the depth is what the indent is measuring. */
  paddingLeft?: string
  isActive: boolean
  isReviewed: boolean
  hasChangedSince: boolean
  unresolved: number
  onSelect: (path: string) => void
}) {
  const path = file.path

  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      style={{ paddingLeft: paddingLeft ?? '0.25rem' }}
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
})
