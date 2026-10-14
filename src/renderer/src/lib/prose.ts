/**
 * Which files are text to be read rather than code to be scanned.
 *
 * The difference changes how a file is drawn. Code is laid out in lines that
 * mean something - indentation, alignment, one statement per row - so it is
 * shown exactly as written and scrolls sideways when a line is long. Prose is
 * laid out by whoever wraps it: a paragraph of Markdown is very often one line
 * of several hundred characters, and drawing that unwrapped is a horizontal
 * scrollbar the width of a novel. So prose wraps, and Markdown can also be read
 * rendered.
 *
 * Decided by extension, the way syntax colours are, because that is the only
 * thing every view has in hand before it has read the file.
 */

const MARKDOWN = /\.(md|mdx|markdown|mdown|mkd)$/i

/** Plain text formats that are written in paragraphs. */
const PROSE = /\.(md|mdx|markdown|mdown|mkd|txt|text|rst|adoc|asciidoc|org|tex)$/i

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN.test(path)
}

export function isProsePath(path: string): boolean {
  return PROSE.test(path)
}
