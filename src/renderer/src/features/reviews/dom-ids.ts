/**
 * Ids for the two things in Files changed that get scrolled to: a file's card,
 * and a line inside it.
 *
 * They live in their own module because three unrelated places need to agree on
 * them - the file tree scrolls to a card, the tab scrolls to a line when
 * arriving from the conversation, and the diff renders both - and a scroll
 * target that is computed differently in two places is a jump that silently
 * stops working.
 *
 * Paths are percent-encoded, so an id is always safe in `getElementById` and in
 * a hash. Lines are only ever numbers.
 */
import type { DiffSide } from '@shared/comment-anchors'

export function fileDomId(path: string): string {
  return `file-${encodeURIComponent(path)}`
}

export function lineDomId(path: string, side: DiffSide, line: number): string {
  return `line-${encodeURIComponent(path)}-${side}-${line}`
}

/**
 * The one search hit the reader is currently being pointed at.
 *
 * A fixed id rather than one per hit, because only ever one of them is current.
 * The find bar scrolls to the mark rather than to the row holding it, so a hit
 * sitting a long way along a long line is brought into view sideways as well -
 * the code scrolls horizontally inside its own container, and a row scrolled to
 * vertically can still be showing the wrong end of itself.
 */
export const ACTIVE_MATCH_ID = 'diff-find-active-match'
