/**
 * Syntax colours for a diff card, a file card and a comment's snippet.
 *
 * The how lives in `lib/highlight`; this is the part that knows what each of
 * the three views has in hand. See `lib/highlight/diff-blocks.ts` for why a
 * diff is tokenized hunk by hunk and side by side.
 */
import { useMemo } from 'react'
import { diffBlocks, diffHighlighter, type LineHighlighter } from '@/lib/highlight/diff-blocks'
import { languageForPath } from '@/lib/highlight/languages'
import { useHighlightedBlocks } from '@/lib/highlight/use-highlight'
import type { DiffLine } from '@shared/git'

/**
 * Colours for the rows of one file's diff.
 *
 * `fileLines` is the whole head-side file when the card has read it - to
 * unfold context - and null until then. Unfolded rows only exist once it has
 * been read, so they are always covered by it.
 *
 * `enabled` is false while the card is folded: a file nobody has opened costs
 * no tokenizing, the same way it costs no DOM.
 */
export function useDiffHighlight(
  path: string,
  hunks: readonly { lines: readonly DiffLine[] }[],
  fileLines: readonly string[] | null,
  enabled: boolean
): LineHighlighter | undefined {
  const lang = languageForPath(path)
  const layout = useMemo(() => diffBlocks(hunks), [hunks])
  const fileBlocks = useMemo(() => (fileLines === null ? null : [fileLines]), [fileLines])

  const tokens = useHighlightedBlocks(enabled ? layout.blocks : null, lang)
  const fileTokens = useHighlightedBlocks(enabled ? fileBlocks : null, lang)

  return useMemo(
    () =>
      lang === null || !enabled
        ? undefined
        : diffHighlighter(
            layout,
            tokens,
            fileLines !== null && fileTokens !== null
              ? { lines: fileLines, tokens: fileTokens[0] ?? [] }
              : null
          ),
    [lang, enabled, layout, tokens, fileLines, fileTokens]
  )
}

/** Colours for a whole file, shown as context rows numbered on the head side. */
export function useFileHighlight(
  path: string,
  lines: readonly string[] | null
): LineHighlighter | undefined {
  const lang = languageForPath(path)
  const blocks = useMemo(() => (lines === null ? null : [lines]), [lines])
  const tokens = useHighlightedBlocks(blocks, lang)

  return useMemo(() => {
    if (lang === null) return undefined
    const fileTokens = tokens?.[0]
    return (line: DiffLine) =>
      line.newNumber === null ? null : (fileTokens?.[line.newNumber - 1] ?? null)
  }, [lang, tokens])
}

/** Colours for the few lines a comment's snippet shows. */
export function useSnippetHighlight(
  path: string,
  lines: readonly DiffLine[]
): LineHighlighter | undefined {
  // The snippet is a single stretch of one hunk, so it is laid out as one.
  const hunks = useMemo(() => [{ lines }], [lines])
  return useDiffHighlight(path, hunks, null, lines.length > 0)
}
