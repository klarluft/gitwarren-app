/**
 * Text with the characters a fuzzy query actually hit picked out.
 *
 * Shared by every search surface in the app, because a fuzzy result that does
 * not show *why* it matched looks like the search misfired: "wsc" landing on
 * `worktree-self-compare` is obvious only once the three letters are marked.
 *
 * The indices come from `fuzzyMatch`; adjacent hits are coalesced into one
 * <mark> so a run reads as a word rather than as separate letters.
 *
 * Runs go through `Breakable` because what gets searched here is mostly
 * slash-separated - paths, branch names - and a wrapped result should break at
 * its separators rather than through the middle of a segment.
 */
import { Breakable } from '@/components/breakable'
import { cn } from '@/lib/utils'

interface HighlightedTextProps {
  text: string
  /** Indices into `text`, ascending. Empty means "no query", so render plain. */
  indices: number[]
  /** Styling for the matched runs. Defaults to the command palette's weight. */
  markClassName?: string
}

export function HighlightedText({ text, indices, markClassName }: HighlightedTextProps) {
  if (indices.length === 0) return <Breakable text={text} />

  const hit = new Set(indices)
  const parts: { text: string; match: boolean }[] = []

  for (let position = 0; position < text.length; position += 1) {
    const match = hit.has(position)
    const last = parts.at(-1)
    if (last && last.match === match) last.text += text[position]
    else parts.push({ text: text[position] as string, match })
  }

  return (
    <>
      {parts.map((part, partIndex) =>
        part.match ? (
          <mark
            key={partIndex}
            className={cn('bg-transparent font-semibold text-foreground', markClassName)}
          >
            <Breakable text={part.text} />
          </mark>
        ) : (
          <span key={partIndex}>
            <Breakable text={part.text} />
          </span>
        )
      )}
    </>
  )
}
