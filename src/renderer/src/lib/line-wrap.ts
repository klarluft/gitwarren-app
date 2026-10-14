/**
 * Whether long lines wrap - one choice, with a different default for prose.
 *
 * Code is shown as written and scrolls sideways; prose wraps, because a
 * paragraph of Markdown is a single line several hundred characters long (see
 * `prose.ts`). That is the right *default*, and for a while it was also the
 * only option: prose was wrapped regardless of the Wrap lines button, so the
 * button did nothing at all on a Markdown file and there was no way to see a
 * table or a long link the way it is laid out in the source.
 *
 * So there are two remembered switches, one per kind of file, and the button
 * sets both. Before anybody has pressed it, code is unwrapped and prose is
 * wrapped; once somebody has, every file does what they said. Two keys rather
 * than one three-way value so that `diff-wrap`, which people already have
 * stored, keeps meaning exactly what it meant.
 */
import { useCallback } from 'react'
import { useStoredFlag } from './preferences'
import { isProsePath } from './prose'

export interface LineWrap {
  /** Whether code wraps. */
  code: boolean
  /** Whether prose wraps. */
  prose: boolean
  /** Whether this file's lines wrap. */
  wrapFor: (path: string) => boolean
  /** Wrap everything, or nothing. */
  setWrap: (next: boolean) => void
}

export function useLineWrap(): LineWrap {
  const [code, setCode] = useStoredFlag('diff-wrap', false)
  const [prose, setProse] = useStoredFlag('prose-wrap', true)

  const wrapFor = useCallback((path: string) => (isProsePath(path) ? prose : code), [code, prose])
  const setWrap = useCallback(
    (next: boolean) => {
      setCode(next)
      setProse(next)
    },
    [setCode, setProse]
  )

  return { code, prose, wrapFor, setWrap }
}
