/**
 * Cutting one line into the pieces it is drawn with.
 *
 * Two things want to wrap parts of a line at once: syntax colours, and the find
 * in the diff, whose hits are `<mark>` elements. They do not nest - a search
 * for `= use` starts inside one token and ends inside another - so neither can
 * simply be drawn around the other. The line is cut at every boundary either of
 * them has, and the pieces are grouped back under the hit they belong to: each
 * hit stays one `<mark>` (one element to scroll to, one outline), and inside it
 * every piece keeps its own colour.
 *
 * DOM-free, so it is unit-tested under node.
 */
import type { CodeToken } from './tokenize'

export interface Piece {
  text: string
  /** Null for plain text. */
  token: CodeToken | null
}

export interface Segment {
  /** Index of the search hit this segment is, or null for text between hits. */
  match: number | null
  pieces: Piece[]
}

export interface Range {
  start: number
  end: number
}

/**
 * The line as runs that cover it end to end, plain where no token is.
 *
 * Tokens are clamped to the line and anything overlapping the run before it is
 * dropped: the tokens describe this text, but the text is what is drawn, and
 * it must come out exactly once whatever the tokens say.
 */
function runs(
  content: string,
  tokens: readonly CodeToken[] | null
): Array<Range & { token: CodeToken | null }> {
  const result: Array<Range & { token: CodeToken | null }> = []
  let cursor = 0
  for (const token of tokens ?? []) {
    const start = Math.max(token.start, cursor)
    const end = Math.min(token.end, content.length)
    if (end <= start) continue
    if (start > cursor) result.push({ start: cursor, end: start, token: null })
    result.push({ start, end, token })
    cursor = end
  }
  if (cursor < content.length) result.push({ start: cursor, end: content.length, token: null })
  return result
}

/**
 * Split `content` into segments - plain stretches and search hits - each made
 * of coloured pieces.
 *
 * `matches` are in order and do not overlap, which is how `matchOffsets`
 * produces them.
 */
export function segmentLine(
  content: string,
  tokens: readonly CodeToken[] | null,
  matches: readonly Range[]
): Segment[] {
  const pieces = runs(content, tokens)

  // The regions to fill: what lies between the hits, and the hits themselves.
  const regions: Array<Range & { match: number | null }> = []
  let cursor = 0
  for (const [index, match] of matches.entries()) {
    const start = Math.max(match.start, cursor)
    const end = Math.min(match.end, content.length)
    if (end <= start) continue
    if (start > cursor) regions.push({ start: cursor, end: start, match: null })
    regions.push({ start, end, match: index })
    cursor = end
  }
  if (cursor < content.length) regions.push({ start: cursor, end: content.length, match: null })

  const segments: Segment[] = []
  let run = 0
  for (const region of regions) {
    const segment: Segment = { match: region.match, pieces: [] }
    // Runs are walked once in total: a run that straddles the region's end is
    // left in place for the next region to take the rest of.
    for (let current = pieces[run]; current !== undefined; current = pieces[run]) {
      if (current.start >= region.end) break
      const start = Math.max(current.start, region.start)
      const end = Math.min(current.end, region.end)
      if (end > start)
        segment.pieces.push({
          text: content.slice(start, end),
          token: current.token
        })
      if (current.end <= region.end) run += 1
      else break
    }
    segments.push(segment)
  }
  return segments
}
