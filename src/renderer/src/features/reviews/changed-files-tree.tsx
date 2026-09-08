/**
 * The list of changed files beside the diff.
 *
 * A flat list of paths is unreadable past about a dozen files - every row
 * starts with the same forty characters - so the paths are folded into a tree.
 * Directories with a single child are collapsed into their parent
 * (`src/renderer/src` on one row), which is what makes a deep source tree fit
 * in a narrow column and is the one thing GitHub's file tree gets most right.
 *
 * The tree is a *navigation* aid, not a second copy of the diff: it scrolls the
 * page to a file, and it says how much changed and whether anyone commented.
 * Everything else stays in the file card.
 */
import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileStatusIcon } from './diff-view'
import { FilePath } from './file-path'
import type { FileDiff } from '@shared/git'

interface FileNode {
  kind: 'file'
  /** Full repository-relative path - also the DOM anchor and the tree key. */
  path: string
  name: string
  file: FileDiff
}

interface DirectoryNode {
  kind: 'directory'
  path: string
  /** May be several segments, when a chain of lone directories was folded. */
  name: string
  children: TreeNode[]
}

type TreeNode = FileNode | DirectoryNode

function buildTree(files: FileDiff[]): TreeNode[] {
  const root: DirectoryNode = { kind: 'directory', path: '', name: '', children: [] }

  for (const file of files) {
    const segments = file.path.split('/')
    const name = segments.pop() as string
    let parent = root

    for (const segment of segments) {
      const path = parent.path ? `${parent.path}/${segment}` : segment
      const existing = parent.children.find(
        (child): child is DirectoryNode => child.kind === 'directory' && child.path === path
      )
      if (existing) {
        parent = existing
      } else {
        const created: DirectoryNode = { kind: 'directory', path, name: segment, children: [] }
        parent.children.push(created)
        parent = created
      }
    }

    parent.children.push({ kind: 'file', path: file.path, name, file })
  }

  // The root itself is not collapsed: folding it away would silently drop the
  // one directory every file in the review shares, which is exactly the label
  // that tells you what part of the tree you are looking at.
  return root.children.map((child) => (child.kind === 'directory' ? collapse(child) : child))
}

/** Fold `a` -> `b` -> [files] into a single `a/b` row. */
function collapse(node: DirectoryNode): DirectoryNode {
  const children = node.children.map((child) =>
    child.kind === 'directory' ? collapse(child) : child
  )

  const only = children.length === 1 ? children[0] : undefined
  if (only?.kind === 'directory') {
    return {
      kind: 'directory',
      path: only.path,
      name: node.name ? `${node.name}/${only.name}` : only.name,
      children: only.children
    }
  }

  return { ...node, children }
}

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

export function ChangedFilesTree({
  files,
  activePath,
  onSelect,
  unresolvedByFile,
  reviewedPaths,
  changedSincePaths
}: ChangedFilesTreeProps) {
  const tree = useMemo(() => buildTree(files), [files])

  return (
    <nav aria-label="Changed files" className="flex flex-col gap-px py-1 text-xs">
      {tree.map((node) => (
        <TreeRows
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
          unresolvedByFile={unresolvedByFile}
          reviewedPaths={reviewedPaths}
          changedSincePaths={changedSincePaths}
        />
      ))}
    </nav>
  )
}

function TreeRows({
  node,
  depth,
  activePath,
  onSelect,
  unresolvedByFile,
  reviewedPaths,
  changedSincePaths
}: {
  node: TreeNode
  depth: number
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
              activePath={activePath}
              onSelect={onSelect}
              unresolvedByFile={unresolvedByFile}
              reviewedPaths={reviewedPaths}
              changedSincePaths={changedSincePaths}
            />
          ))}
      </>
    )
  }

  const unresolved = unresolvedByFile.get(node.path) ?? 0
  const isActive = node.path === activePath
  const isReviewed = reviewedPaths.has(node.path)
  const hasChangedSince = changedSincePaths.has(node.path)

  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      style={indent}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-1.5 rounded py-1 pr-1 text-left transition-colors',
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        // Read files stay legible but recede, so what is left to do stands out.
        isReviewed && !isActive && 'text-muted-foreground'
      )}
      title={
        hasChangedSince
          ? `${node.path} - changed since you reviewed it`
          : isReviewed
            ? `${node.path} - reviewed`
            : node.path
      }
    >
      {isReviewed ? (
        <Check className="mt-0.5 size-3 shrink-0 text-success" />
      ) : hasChangedSince ? (
        <History className="mt-0.5 size-3 shrink-0 text-warning" />
      ) : (
        <FileStatusIcon status={node.file.status} className="mt-0.5 size-3 shrink-0" />
      )}
      {/* The whole name, wrapped if it has to be. A file list that cannot tell
          you which file a row is is not doing the one job it has. */}
      <span className="min-w-0 flex-1 break-words font-mono text-[0.6875rem]">{node.name}</span>
      {unresolved > 0 && (
        <span
          className="shrink-0 rounded-full bg-primary px-1 text-[0.5625rem] font-semibold leading-4 text-primary-foreground"
          title={`${unresolved} unresolved`}
        >
          {unresolved}
        </span>
      )}
      {!node.file.isBinary && (
        <span className="mt-px shrink-0 font-mono text-[0.625rem] tabular-nums">
          <span className="text-success">+{node.file.additions}</span>{' '}
          <span className="text-destructive">−{node.file.deletions}</span>
        </span>
      )}
    </button>
  )
}
