/**
 * The React side of syntax highlighting: which scheme is on screen, the hook
 * that asks for tokens, and the spans they are drawn with.
 *
 * Highlighting is always an enhancement on top of text that is already there.
 * Every caller draws plain lines first and colours them when the tokens land,
 * so a slow grammar, an unknown language or a failure anywhere in Shiki leaves
 * the code exactly as readable as it was before any of this existed.
 */
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode
} from 'react'
import type { LanguageId } from './languages'
import type { Piece } from './segments'
import {
  highlightKey,
  peekHighlight,
  requestHighlight,
  type CodeToken,
  type ColorScheme,
  type LineTokens
} from './tokenize'

function subscribeToScheme(onChange: () => void): () => void {
  // `main.tsx` owns the `.dark` class and moves it with the OS setting. Watching
  // the class rather than the media query keeps the code colours tied to what
  // the rest of the window actually is, whoever decided it.
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
  return () => observer.disconnect()
}

function currentScheme(): ColorScheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeToScheme, currentScheme)
}

/**
 * Tokens for each of `blocks`, line for line, or null until they are ready -
 * and for good when there is nothing to colour them with.
 *
 * Each block is tokenized from a clean grammar state: pass a whole file as one
 * block, a diff's hunks as one block each.
 */
export function useHighlightedBlocks(
  blocks: readonly (readonly string[])[] | null,
  lang: LanguageId | null
): LineTokens[][] | null {
  const scheme = useColorScheme()

  // A string, so a caller that rebuilds the same lines on every render - a
  // snippet derived from a thread - lands on the same key and asks once.
  const key = useMemo(
    () => (blocks === null || lang === null ? null : highlightKey(blocks, lang, scheme)),
    [blocks, lang, scheme]
  )
  const [settled, setSettled] = useState<{
    key: string
    tokens: LineTokens[][] | null
  } | null>(null)

  useEffect(() => {
    if (key === null || blocks === null || lang === null) return
    if (peekHighlight(key) !== undefined) return

    let isCurrent = true
    const job = requestHighlight(key, blocks, lang, scheme)
    void job.promise.then((tokens) => {
      if (isCurrent) setSettled({ key, tokens })
    })
    return () => {
      isCurrent = false
      job.release()
    }
    // `blocks` is read only when the key - which is built from it - changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (key === null) return null
  if (settled?.key === key) return settled.tokens
  return peekHighlight(key) ?? null
}

/** Inline style for a token; colours are per token, so not worth a class each. */
export function tokenStyle(token: CodeToken): CSSProperties | undefined {
  if (token.color === null && token.fontStyle === 0) return undefined
  const style: CSSProperties = {}
  if (token.color !== null) style.color = token.color
  if (token.fontStyle & 1) style.fontStyle = 'italic'
  if (token.fontStyle & 2) style.fontWeight = 600
  if (token.fontStyle & 12) {
    style.textDecorationLine = [
      token.fontStyle & 4 ? 'underline' : '',
      token.fontStyle & 8 ? 'line-through' : ''
    ]
      .join(' ')
      .trim()
  }
  return style
}

export function renderPieces(pieces: readonly Piece[]): ReactNode[] {
  return pieces.map((piece, index) => {
    const style = piece.token === null ? undefined : tokenStyle(piece.token)
    return style === undefined ? (
      piece.text
    ) : (
      <span key={index} style={style}>
        {piece.text}
      </span>
    )
  })
}
