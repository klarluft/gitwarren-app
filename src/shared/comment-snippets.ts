/**
 * The few lines of a diff that a comment is about.
 *
 * The conversation tab shows discussions away from the code, and a line comment
 * read on its own is close to useless - "this should be awaited" means nothing
 * without the line it points at. GitHub prints a small hunk above each review
 * comment for exactly this reason, and this is the piece that picks the lines.
 *
 * The module also decides *which* code that is: the current diff while the
 * comment still anchors to a line in it, and the snapshot stored when the
 * comment was written once it does not. See `threadSnippet` at the bottom.
 *
 * Pure and dependency-free like its sibling `comment-anchors`, and for the same
 * reason: the renderer runs it against the diff it has already fetched, and the
 * MCP server can run it against one it reads itself.
 */
import { isInlineAnchor, type DiffSide, type ResolvedAnchor } from './comment-anchors.js'
import type { AnchorState } from './comment-anchors.js'
import type { DiffLine, FileDiff } from './git.js'
import type { CommentThread } from './schemas.js'

/** How many lines of lead-in a snippet carries by default. */
export const SNIPPET_CONTEXT_LINES = 3

/**
 * Ceiling on a snapshot taken for a multi-line comment. Someone can select two
 * hundred lines; storing all of them in every thread row would make the
 * discussion bigger than the code it is about, and nobody reads a two-hundred
 * line quotation above a comment either.
 */
export const MAX_SNIPPET_LINES = 40

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

/**
 * Choosing which code to show above a line comment.
 *
 * There are two candidates and the order between them is the whole point:
 *
 *  1. The current diff, when the comment still anchors to a line in it. This is
 *     what the reviewer would see in Files changed, so a comment that is still
 *     live is discussed against code that is still live.
 *  2. The snapshot taken when the comment was written, when it does not. The
 *     code it was about has been rewritten or has left the diff; the snapshot is
 *     the only remaining record of what the commenter was looking at, and
 *     showing it is what keeps an outdated discussion readable instead of
 *     leaving it stranded next to nothing.
 *
 * Falling back is always marked `historical`, because a snapshot presented as
 * current code would be a straightforwardly false statement about the branch.
 *
 * The last resort is `anchorText` alone - one line, no context. Threads created
 * before snapshots existed have only that, and one line beats none.
 */
export interface ThreadSnippet {
  filePath: string
  side: DiffSide
  line: number | null
  /** First line of the range, when the comment covers more than one. */
  startLine: number | null
  lines: DiffLine[]
  clipped: boolean
  state: AnchorState
  historical: boolean
  capturedSha: string | null
}

/**
 * Lead-in for a thread: enough to cover its whole range, plus the usual few
 * lines above it, capped so a large selection cannot bloat the snapshot.
 */
export function contextForRange(startLine: number | null, line: number): number {
  const span = startLine === null ? 0 : Math.max(line - startLine, 0)
  return Math.min(span, MAX_SNIPPET_LINES) + SNIPPET_CONTEXT_LINES
}

/** The single stored line, for threads that predate snapshots. */
function fromAnchorText(thread: CommentThread, side: DiffSide): DiffLine[] {
  if (thread.anchorText === null) return []
  return [
    {
      type: 'context',
      content: thread.anchorText,
      oldNumber: side === 'base' ? thread.line : null,
      newNumber: side === 'head' ? thread.line : null
    }
  ]
}

/**
 * What to draw above `thread`, or null if it is a review-level thread.
 *
 * `anchor` is null while the diff is still being read. That is not the same as
 * "outdated": the app does not yet know where the comment lands, so the
 * snapshot is shown without any claim about the branch, and the badges appear
 * once the diff arrives.
 */
export function threadSnippet(
  thread: CommentThread,
  anchor: ResolvedAnchor | null,
  file: FileDiff | undefined
): ThreadSnippet | null {
  if (!isInlineAnchor(thread)) return null

  const live =
    anchor === null || anchor.line === null
      ? null
      : snippetAt(
          file,
          thread.side,
          anchor.line,
          contextForRange(anchor.startLine, anchor.line)
        )

  if (live !== null && anchor !== null) {
    return {
      // Under the file's current name, so a comment left before a rename is
      // filed against the file the reviewer is looking at now.
      filePath: file?.path ?? thread.filePath,
      side: thread.side,
      line: anchor.line,
      startLine: anchor.startLine,
      lines: live.lines,
      clipped: live.clipped,
      state: anchor.state,
      historical: false,
      capturedSha: thread.anchorSha
    }
  }

  const snapshot = thread.anchorSnapshot

  return {
    filePath: file?.path ?? thread.filePath,
    side: thread.side,
    line: thread.line,
    startLine: thread.startLine,
    lines: snapshot?.lines ?? fromAnchorText(thread, thread.side),
    clipped: snapshot?.clipped ?? false,
    state: anchor === null ? 'anchored' : anchor.state,
    historical: anchor !== null,
    capturedSha: thread.anchorSha
  }
}
