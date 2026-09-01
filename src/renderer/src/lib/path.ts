/**
 * The renderer has no Node APIs, so the small amount of path handling the UI
 * needs (previewing the default display name) lives here. Handles both
 * separators because a Windows path can be typed into the field by hand.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}
