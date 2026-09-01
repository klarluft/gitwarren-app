/**
 * The text transformations behind the composer's toolbar and its Enter key.
 *
 * Kept as pure functions over `{ value, selectionStart, selectionEnd }` rather
 * than reaching into the textarea, because every one of them has to answer the
 * same two questions - what is the new text, and where should the selection sit
 * afterwards - and a function that only produced the first would leave the
 * caret somewhere arbitrary after every button press. Restoring the selection is
 * what makes the toolbar usable with the keyboard: bold a word, keep typing.
 *
 * They operate on the markdown *source*. That is the whole design: the body
 * column is the interchange format between the person and the agents - an agent
 * writes markdown into it over MCP, the person edits that same string, the agent
 * reads it back - so nothing here parses the text into a document model and
 * re-serialises it. A round trip through a document model reflows fenced code
 * and rewrites bullet markers and emphasis characters, which would quietly
 * rewrite an agent's text every time a human touched a comment.
 */

/** A textarea's state, and the shape every transform returns. */
export interface EditorState {
  value: string
  selectionStart: number
  selectionEnd: number
}

/** Matches a list item and takes it apart: indent, marker, spacing, task box. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/

/** The start of the line containing `index`. */
function lineStart(value: string, index: number): number {
  return value.lastIndexOf('\n', index - 1) + 1
}

/** The end of the line containing `index`, not counting the newline itself. */
function lineEnd(value: string, index: number): number {
  const found = value.indexOf('\n', index)
  return found === -1 ? value.length : found
}

/**
 * Wrap the selection in a pair of markers - `**bold**`, `_italic_`, `` `code` ``.
 *
 * Toggling matters more than it looks: Cmd+B on an already-bold word is how
 * people un-bold it, and a version that only ever added markers would turn it
 * into `****word****`. Both spellings are recognised - the markers inside the
 * selection, and the markers just outside it - because which one you get
 * depends on whether the word was selected by double-click or by dragging.
 */
export function wrapInline(state: EditorState, marker: string, closing = marker): EditorState {
  const { value, selectionStart, selectionEnd } = state
  const selected = value.slice(selectionStart, selectionEnd)

  if (selected.startsWith(marker) && selected.endsWith(closing) &&
      selected.length >= marker.length + closing.length) {
    const stripped = selected.slice(marker.length, selected.length - closing.length)
    return {
      value: value.slice(0, selectionStart) + stripped + value.slice(selectionEnd),
      selectionStart,
      selectionEnd: selectionStart + stripped.length
    }
  }

  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)
  if (before.endsWith(marker) && after.startsWith(closing)) {
    const start = selectionStart - marker.length
    return {
      value: before.slice(0, -marker.length) + selected + after.slice(closing.length),
      selectionStart: start,
      selectionEnd: start + selected.length
    }
  }

  return {
    value: before + marker + selected + closing + after,
    // An empty selection leaves the caret between the markers, ready to type.
    selectionStart: selectionStart + marker.length,
    selectionEnd: selectionStart + marker.length + selected.length
  }
}

/**
 * Insert a link, selecting the part the writer still has to fill in.
 *
 * Which part that is depends on what they had selected: with a word selected
 * the text is settled and the URL is the gap, with nothing selected it is the
 * other way round. Selecting the placeholder rather than just placing a caret
 * means the next keystroke replaces it.
 */
export function insertLink(state: EditorState, url?: string): EditorState {
  const { value, selectionStart, selectionEnd } = state
  const selected = value.slice(selectionStart, selectionEnd)
  const text = selected.length > 0 ? selected : 'text'
  const href = url ?? 'url'
  const inserted = `[${text}](${href})`
  const value_ = value.slice(0, selectionStart) + inserted + value.slice(selectionEnd)

  // With a URL in hand (a paste) nothing is left to fill in, so the caret goes
  // after the link rather than selecting a placeholder that is already right.
  if (url !== undefined && selected.length > 0) {
    const end = selectionStart + inserted.length
    return { value: value_, selectionStart: end, selectionEnd: end }
  }

  const placeholderStart =
    selected.length > 0 ? selectionStart + text.length + 3 : selectionStart + 1
  const placeholderLength = selected.length > 0 ? href.length : text.length
  return {
    value: value_,
    selectionStart: placeholderStart,
    selectionEnd: placeholderStart + placeholderLength
  }
}

/**
 * Put a fenced code block around the selection.
 *
 * Blank lines are forced either side of the fence: a fence that opens on the
 * same line as the paragraph above it is not a fence, it is three backticks in
 * a sentence, and that is a mistake you only see after posting.
 */
export function wrapCodeBlock(state: EditorState): EditorState {
  const { value, selectionStart, selectionEnd } = state
  const selected = value.slice(selectionStart, selectionEnd)
  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)

  const leadIn = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const leadOut = after.length === 0 || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'

  const opening = `${leadIn}\`\`\`\n`
  const inserted = `${opening}${selected}\n\`\`\`${leadOut}`
  return {
    value: before + inserted + after,
    // The caret lands on the (empty) info string, where a language would go.
    selectionStart: selectionStart + leadIn.length + 3,
    selectionEnd: selectionStart + leadIn.length + 3
  }
}

/**
 * Add or remove a line-level marker across every line the selection touches -
 * bullets, numbers, task boxes, quotes.
 *
 * Applying it to whole lines rather than to the selected characters is the
 * difference between "make these three lines a list" and inserting a stray `- `
 * in the middle of a sentence. Removing again when every line already carries
 * the marker makes the button a toggle, which is what a pressed-looking button
 * in a toolbar implies.
 */
export function toggleLinePrefix(
  state: EditorState,
  /** Called per line, so a numbered list can count. */
  marker: (index: number) => string,
  /** Recognises the marker this function would have written, for removal. */
  pattern: RegExp
): EditorState {
  const { value, selectionStart, selectionEnd } = state
  const start = lineStart(value, selectionStart)
  const end = lineEnd(value, selectionEnd)
  const lines = value.slice(start, end).split('\n')

  const allMarked = lines.every((line) => pattern.test(line))
  const rewritten = lines.map((line, index) => {
    if (allMarked) return line.replace(pattern, '')
    // A line that already carries a *different* list marker is converted rather
    // than double-marked: turning a bullet list into a numbered one should not
    // produce "1. - item".
    return marker(index) + line.replace(LIST_ITEM, '$5').replace(/^>\s?/, '')
  })

  const replacement = rewritten.join('\n')
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    selectionStart: start,
    selectionEnd: start + replacement.length
  }
}

export const BULLET = {
  marker: () => '- ',
  pattern: /^\s*[-*+]\s+(?!\[[ xX]\])/
}

export const NUMBERED = {
  marker: (index: number) => `${index + 1}. `,
  pattern: /^\s*\d+[.)]\s+/
}

export const TASK = {
  marker: () => '- [ ] ',
  pattern: /^\s*[-*+]\s+\[[ xX]\]\s+/
}

export const QUOTE = {
  marker: () => '> ',
  pattern: /^>\s?/
}

/**
 * What Enter should do inside a list.
 *
 * This is the single detail that makes a plain textarea feel like GitHub's
 * composer: typing a list is one keystroke per item instead of retyping the
 * marker every time, and - just as important - the list *ends* when you press
 * Enter twice, rather than leaving a trailing `- ` for you to delete.
 *
 * Returns null when the cursor is not on a list item, which is the caller's
 * signal to let the browser insert an ordinary newline.
 */
export function continueList(state: EditorState): EditorState | null {
  const { value, selectionStart, selectionEnd } = state
  const start = lineStart(value, selectionStart)
  const line = value.slice(start, selectionStart)

  const match = LIST_ITEM.exec(line)
  if (!match) return null

  const [, indent = '', bullet = '', spacing = '', task, content = ''] = match

  // An empty item means "I am done with this list". Removing the marker is what
  // lets the second Enter behave normally; inserting another empty item would
  // make the list impossible to leave without reaching for backspace.
  if (content.trim().length === 0) {
    return {
      value: value.slice(0, start) + value.slice(selectionEnd),
      selectionStart: start,
      selectionEnd: start
    }
  }

  const numbered = /^\d+[.)]$/.test(bullet)
  const nextBullet = numbered
    ? `${Number.parseInt(bullet, 10) + 1}${bullet.slice(-1)}`
    : bullet
  // A finished task item continues as an *unticked* one. Carrying the tick over
  // would silently mark the new item done.
  const nextTask = task === undefined ? '' : '[ ] '
  const inserted = `\n${indent}${nextBullet}${spacing}${nextTask}`

  const caret = selectionStart + inserted.length
  return {
    value: value.slice(0, selectionStart) + inserted + value.slice(selectionEnd),
    selectionStart: caret,
    selectionEnd: caret
  }
}

/**
 * Whether pasted text is a bare URL, and so worth turning into a link.
 *
 * Deliberately strict - one token, a real scheme, no whitespace. Anything
 * looser starts eating pastes that merely contain a URL, and a paste that does
 * something surprising to text you did not write is worse than a paste that
 * does nothing clever at all.
 */
export function isUrl(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false
  return /^(https?|ftp|mailto|file):/i.test(trimmed)
}

/** Drop `text` in at the cursor, leaving the caret after it. */
export function insertAtCursor(state: EditorState, text: string): EditorState {
  const { value, selectionStart, selectionEnd } = state
  const caret = selectionStart + text.length
  return {
    value: value.slice(0, selectionStart) + text + value.slice(selectionEnd),
    selectionStart: caret,
    selectionEnd: caret
  }
}
