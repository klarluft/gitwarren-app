/**
 * The last segment of a directory path - the name a worktree is told apart by.
 *
 * Either separator, because the path comes from whichever machine holds the
 * repository: a Windows host reports `C:\Users\…\app`, and the Mac drawing it
 * must still find `app`. A trailing separator is ignored rather than turned
 * into an empty name.
 */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(cut + 1) || path
}
