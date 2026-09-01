/**
 * The few lines of a diff that a comment is about.
 *
 * The conversation tab shows discussions away from the code, and a line comment
 * read on its own is close to useless - "this should be awaited" means nothing
 * without the line it points at. GitHub prints a small hunk above each review
 * comment for exactly this reason, and this is the piece that picks the lines.
 *
 * Pure and dependency-free like its sibling `comment-anchors`, and for the same
 * reason: the renderer runs it against the diff it has already fetched, and the
 * MCP server can run it against one it reads itself.
 */
import type { DiffSide } from './comment-anchors.js'
import type { DiffLine, FileDiff } from './git.js'

/** How many lines of lead-in a snippet carries by default. */
export const SNIPPET_CONTEXT_LINES = 3

export interface AnchorSnippet {
  /** The commented line last, with up to `context` lines of lead-in before it. */
  lines: DiffLine[]
  /** True when the hunk starts further up than the snippet shows. */
  clipped: boolean
}

/** Line numbers live in a different field per side. */
function numberOn(line: DiffLine, side: DiffSide): number | null {
  return side === 'base' ? line.oldNumber : line.newNumber
}

/**
 * The lines to print above a comment: the one it sits on, with a little of what
 * comes before it.
 *
 * The commented line comes last because that is where the eye stops, and the
 * snippet never crosses a hunk boundary - lines either side of a `@@` are not
 * adjacent in the file, so stacking them would be a small lie about the code.
 * A line the diff does not contain gets no snippet rather than a nearby guess.
 */
export function snippetAt(
  file: FileDiff | undefined,
  side: DiffSide,
  line: number,
  context = SNIPPET_CONTEXT_LINES
): AnchorSnippet | null {
  if (!file) return null

  for (const hunk of file.hunks) {
    const index = hunk.lines.findIndex((candidate) => numberOn(candidate, side) === line)
    if (index === -1) continue

    const start = Math.max(0, index - context)
    return { lines: hunk.lines.slice(start, index + 1), clipped: start > 0 }
  }

  return null
}
