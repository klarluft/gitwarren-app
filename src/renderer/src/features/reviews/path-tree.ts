/**
 * Folding a flat list of paths into a tree.
 *
 * A flat list of paths is unreadable past about a dozen files - every row
 * starts with the same forty characters - and a directory chain with one child
 * in it (`src/renderer/src`) wastes three rows saying nothing. Both problems
 * are the same problem, and both lists in this app have them: the changed files
 * beside a diff, and every file in the repository in the browse tab.
 *
 * So the folding lives here and the two trees differ only in what they draw on
 * a row. Nodes carry a path and nothing else on purpose: what a row needs to
 * know about a file - how much changed, whether anyone commented, whether it
 * has been read - is looked up by path by whoever is drawing it, which is the
 * one thing that stops this module growing a field per feature.
 */

export interface PathFileNode {
  kind: 'file'
  /** Full repository-relative path - also the DOM anchor and the tree key. */
  path: string
  name: string
}

export interface PathDirectoryNode {
  kind: 'directory'
  path: string
  /** May be several segments, when a chain of lone directories was folded. */
  name: string
  children: PathNode[]
}

export type PathNode = PathFileNode | PathDirectoryNode

/**
 * Build the tree, in the order the paths arrive.
 *
 * Deliberately not sorted here. The changed-files list is already sorted by the
 * diff and the browse tree by the tree read, and re-sorting would either be a
 * no-op or would silently disagree with the order the caller chose.
 */
export function buildPathTree(paths: string[]): PathNode[] {
  const root: PathDirectoryNode = { kind: 'directory', path: '', name: '', children: [] }
  // One map rather than a linear scan of `children` per segment: with twenty
  // thousand paths the scan is the difference between a tree that builds in a
  // few milliseconds and one that takes a visible pause.
  const directories = new Map<string, PathDirectoryNode>([['', root]])

  for (const path of paths) {
    const segments = path.split('/')
    const name = segments.pop() as string
    let parent = root

    for (const segment of segments) {
      const directoryPath = parent.path ? `${parent.path}/${segment}` : segment
      const existing = directories.get(directoryPath)
      if (existing) {
        parent = existing
      } else {
        const created: PathDirectoryNode = {
          kind: 'directory',
          path: directoryPath,
          name: segment,
          children: []
        }
        parent.children.push(created)
        directories.set(directoryPath, created)
        parent = created
      }
    }

    parent.children.push({ kind: 'file', path, name })
  }

  // The root itself is not collapsed: folding it away would silently drop the
  // one directory every file in the list shares, which is exactly the label
  // that tells you what part of the tree you are looking at.
  return root.children.map((child) => (child.kind === 'directory' ? collapse(child) : child))
}

/** Fold `a` -> `b` -> [files] into a single `a/b` row. */
function collapse(node: PathDirectoryNode): PathDirectoryNode {
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
