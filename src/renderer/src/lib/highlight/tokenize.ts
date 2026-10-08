/**
 * Turning lines of code into coloured runs, with GitHub's own palette.
 *
 * ## Shiki, with the JavaScript regex engine
 *
 * Shiki reads the same TextMate grammars VS Code does, and ships GitHub's light
 * and dark themes, so a diff here is coloured the way the same diff is on
 * github.com. Its default regex engine is Oniguruma compiled to WebAssembly,
 * which the renderer's CSP refuses - `script-src 'self'` has no
 * `'wasm-unsafe-eval'`, deliberately. The JavaScript engine translates the
 * grammars' patterns to native `RegExp` instead: no WASM, no `eval`, nothing in
 * the policy to loosen. `forgiving` makes a pattern it cannot translate match
 * nothing rather than throw, so one exotic rule costs a few uncoloured tokens,
 * not the whole file.
 *
 * ## One theme at a time
 *
 * Shiki can colour for two themes at once, but it does that by tokenizing twice.
 * The window follows the OS scheme and changes it about as often as the OS
 * does, so only the scheme on screen is tokenized; a switch re-tokenizes, and
 * the cache keeps both once both have been seen.
 *
 * ## Off the critical path, without a worker
 *
 * Tokenizing is the expensive part - about 70 lines a millisecond once a
 * grammar is warm, several hundred milliseconds the first time a grammar
 * compiles its patterns. A worker would be the textbook answer, and is the one
 * thing here that is awkward in both shells: the packaged window loads from
 * `file://`, where module workers are origin-less. So the work is done on the
 * main thread in slices instead - a few hundred lines, then the thread is handed
 * back - with Shiki's grammar state carried across each slice so a block
 * comment opened in one is still open in the next. Jobs run one at a time in
 * the order they were asked for, which in a diff is top to bottom: the file the
 * reader is looking at is coloured first.
 *
 * A job nobody is waiting for any more - the card was folded, the review was
 * closed - is abandoned at the next slice rather than finished for nobody.
 */
import type { GrammarState, HighlighterCore, ThemedToken } from 'shiki/core'
import { GRAMMARS, type LanguageId } from './languages'

export type ColorScheme = 'light' | 'dark'

/** GitHub's current Primer themes - what github.com draws code with today. */
const THEMES: Record<ColorScheme, string> = {
  light: 'github-light-default',
  dark: 'github-dark-default'
}

/**
 * One coloured run of a line, by offset into that line.
 *
 * Offsets rather than the text itself, so the line is always drawn from its own
 * content: whatever the tokenizer did with a stray `\r` or a line too long to
 * colour, the characters on screen are the characters in the diff.
 */
export interface CodeToken {
  start: number
  end: number
  /** Null for the theme's plain foreground, which the row's own colour stands in for. */
  color: string | null
  /** Shiki's bit set: 1 italic, 2 bold, 4 underline, 8 strikethrough. */
  fontStyle: number
}

export type LineTokens = CodeToken[]

/** Lines per slice - roughly 4ms of work on a warm grammar. */
const SLICE_LINES = 250

/**
 * Lines past this length are left uncoloured. Minified bundles and lockfiles
 * hold single lines of hundreds of kilobytes, and a regex walking one of those
 * is where the time would go.
 */
const MAX_LINE_LENGTH = 2_000

/** How much tokenized text the cache keeps, counted in characters of source. */
const CACHE_BUDGET = 8_000_000

let highlighter: Promise<HighlighterCore> | null = null

/**
 * Shiki itself is loaded on first use, like the grammars: its core and the
 * regex translator are a few hundred kilobytes that a window showing no code
 * yet - the repository list, a fresh launch - has no reason to parse.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        themes: [
          import('shiki/themes/github-light-default.mjs'),
          import('shiki/themes/github-dark-default.mjs')
        ],
        langs: []
      })
  )
  // A failed load is retried by the next request rather than remembered.
  highlighter.catch(() => {
    highlighter = null
  })
  return highlighter
}

const languages = new Map<LanguageId, Promise<void>>()

function loadLanguage(core: HighlighterCore, lang: LanguageId): Promise<void> {
  let loaded = languages.get(lang)
  if (!loaded) {
    loaded = GRAMMARS[lang]().then((module) => core.loadLanguage(module.default))
    // A grammar that failed to arrive - a chunk lost to a flaky `serve`
    // connection - may be asked for again next time rather than never.
    loaded.catch(() => languages.delete(lang))
    languages.set(lang, loaded)
  }
  return loaded
}

/** Hand the thread back so input and paint get a turn between slices. */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function toLineTokens(tokens: ThemedToken[], foreground: string): LineTokens {
  const result: LineTokens = []
  let offset = 0
  for (const token of tokens) {
    const end = offset + token.content.length
    const color = token.color && token.color.toLowerCase() !== foreground ? token.color : null
    // Shiki's `FontStyle` enum, read as the bit set it is; -1 means "not set".
    const fontStyle = Math.max(0, Number(token.fontStyle ?? 0))
    // Plain runs are not stored at all: a gap between tokens is drawn as
    // plain text, and most of a line in most languages is plain.
    if (end > offset && (color !== null || fontStyle !== 0)) {
      result.push({ start: offset, end, color, fontStyle })
    }
    offset = end
  }
  return result
}

class Abandoned extends Error {}

/**
 * Tokenize each block on its own, slice by slice.
 *
 * Blocks are independent on purpose: a diff's hunks are separate stretches of
 * a file, and the grammar state at the end of one says nothing true about the
 * start of the next.
 */
async function tokenizeBlocks(
  blocks: readonly (readonly string[])[],
  lang: LanguageId,
  scheme: ColorScheme,
  isWanted: () => boolean
): Promise<LineTokens[][] | null> {
  const core = await getHighlighter()
  await loadLanguage(core, lang)

  const theme = THEMES[scheme]
  const foreground = (core.getTheme(theme).fg ?? '').toLowerCase()
  const result: LineTokens[][] = []

  for (const block of blocks) {
    const lines: LineTokens[] = []
    let grammarState: GrammarState | undefined

    for (let from = 0; from < block.length; from += SLICE_LINES) {
      if (!isWanted()) throw new Abandoned()
      const slice = block.slice(from, from + SLICE_LINES)
      const tokens = core.codeToTokens(slice.join('\n'), {
        lang,
        theme,
        grammarState,
        tokenizeMaxLineLength: MAX_LINE_LENGTH
      })

      // The lines are joined on `\n` and split back on it, so the counts can
      // only disagree if something in between went wrong. Plain text is the
      // honest answer then; colours shifted a line out of place are not.
      if (tokens.tokens.length !== slice.length) return null

      for (const line of tokens.tokens) lines.push(toLineTokens(line, foreground))
      grammarState = tokens.grammarState
      await yieldToMain()
    }

    result.push(lines)
  }

  return result
}

interface Entry {
  promise: Promise<LineTokens[][] | null>
  /** Set once the promise has settled. */
  value?: LineTokens[][] | null
  /** Components still waiting on an unfinished job. */
  waiting: number
  size: number
}

/** Insertion-ordered, so the first key is the least recently used. */
const cache = new Map<string, Entry>()
let cached = 0

/** Serialises jobs: each starts when the one before it has finished. */
let queue: Promise<unknown> = Promise.resolve()

function evict(): void {
  for (const [key, entry] of cache) {
    if (cached <= CACHE_BUDGET) break
    // Unfinished work is never evicted - somebody is waiting on it.
    if (!('value' in entry)) continue
    cache.delete(key)
    cached -= entry.size
  }
}

/**
 * What a set of blocks is cached under. The source is part of the key, so an
 * edit to the file is a new entry rather than a stale hit.
 */
export function highlightKey(
  blocks: readonly (readonly string[])[],
  lang: LanguageId,
  scheme: ColorScheme
): string {
  return `${scheme}\u0000${lang}\u0000${blocks.map((block) => block.join('\n')).join('\u0000')}`
}

/**
 * The finished tokens for a key, if they are already in hand.
 *
 * Read synchronously so a card that is folded and opened again is coloured on
 * its first frame, rather than flashing plain while a cache hit resolves.
 */
export function peekHighlight(key: string): LineTokens[][] | null | undefined {
  const entry = cache.get(key)
  if (!entry || !('value' in entry)) return undefined
  // Touch it, so what is on screen is the last thing to be evicted.
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

/**
 * Ask for blocks to be tokenized. `release` says the caller no longer needs
 * them; a job everybody has released is dropped before its next slice.
 */
export function requestHighlight(
  key: string,
  blocks: readonly (readonly string[])[],
  lang: LanguageId,
  scheme: ColorScheme
): { promise: Promise<LineTokens[][] | null>; release: () => void } {
  let entry = cache.get(key)

  if (!entry) {
    const size = key.length
    const created: Entry = {
      waiting: 0,
      size,
      promise: Promise.resolve(null)
    }
    const run = (): Promise<LineTokens[][] | null> =>
      tokenizeBlocks(blocks, lang, scheme, () => created.waiting > 0)
    created.promise = queue.then(run).then(
      (value) => {
        created.value = value
        evict()
        return value
      },
      (error: unknown) => {
        // Abandoned or failed: forget it, so the next reader starts afresh
        // rather than inheriting a job that never finished.
        if (cache.get(key) === created) {
          cache.delete(key)
          cached -= size
        }
        if (!(error instanceof Abandoned)) console.warn('Syntax highlighting failed', error)
        return null
      }
    )
    queue = created.promise
    cache.set(key, created)
    cached += size
    entry = created
  }

  const held = entry
  held.waiting += 1
  let released = false

  return {
    promise: held.promise,
    release: () => {
      if (released) return
      released = true
      held.waiting -= 1
    }
  }
}
