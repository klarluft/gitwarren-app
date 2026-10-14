/**
 * Where a link or an image in a repository's Markdown file points.
 *
 * A README links to `docs/setup.md`, a chapter to `../02-the-plan.md#costs`,
 * and draws `./diagram.png`. Those are paths inside the repository, written
 * relative to the file they are in - or, GitHub-style, to the repository's root
 * when they start with a `/` - and the preview can follow them without ever
 * leaving the app. Anything with a scheme (`https:`, `mailto:`) is somewhere
 * else, and is left to the real browser.
 */

/**
 * The repository path `src` names from the document at `documentPath`, or null
 * when it is not one: a URL, a bare `#fragment`, an attachment token, or a path
 * that climbs out of the repository.
 */
export function resolveDocumentPath(documentPath: string, src: string): string | null {
  if (src === '' || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) {
    return null
  }
  let clean = src.split(/[?#]/)[0] ?? ''
  try {
    clean = decodeURI(clean)
  } catch {
    // A stray `%` - use the path as written.
  }
  // Root-relative, the way GitHub reads it: from the top of the repository.
  const parts = clean.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}

export type DocumentLink =
  /** A heading in this same document. */
  | { kind: 'anchor'; fragment: string }
  /** Another file (or folder) in the repository, perhaps at a heading in it. */
  | { kind: 'file'; path: string; fragment: string | null }
  /** A relative path that climbs out of the repository: nowhere to go. */
  | { kind: 'outside' }
  /** A URL. The real browser's business. */
  | { kind: 'external' }

/**
 * The file to open for a link to `path`, given every file in the repository.
 *
 * A file is itself. A folder - `docs/`, or `docs` - is its README, the page
 * GitHub would show for it, when it has one; otherwise its path is returned as
 * it is and the file card says it cannot be read, which is still more use than
 * a click that does nothing.
 */
export function fileForLink(paths: readonly string[], path: string): string {
  if (paths.includes(path)) return path
  const prefix = `${path}/`
  const readme = paths.find(
    (candidate) =>
      candidate.startsWith(prefix) &&
      !candidate.slice(prefix.length).includes('/') &&
      /^readme(\.(md|markdown|mdx|txt))?$/i.test(candidate.slice(prefix.length))
  )
  return readme ?? path
}

export function documentLink(documentPath: string, href: string): DocumentLink {
  if (href.startsWith('#')) return { kind: 'anchor', fragment: href.slice(1) }
  if (href === '' || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    return { kind: 'external' }
  }
  const path = resolveDocumentPath(documentPath, href)
  if (path === null) return { kind: 'outside' }
  const hash = href.indexOf('#')
  const fragment = hash === -1 ? null : href.slice(hash + 1)
  // `other.md#` and a link to this very file are just this file.
  if (path === documentPath) {
    return fragment === null || fragment === '' ? { kind: 'file', path, fragment: null } : { kind: 'anchor', fragment }
  }
  return { kind: 'file', path, fragment: fragment === '' ? null : fragment }
}
