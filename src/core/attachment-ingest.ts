/**
 * Rewriting the local image paths in a body into attachment tokens.
 *
 * This is the agent write path. An agent writes a screenshot to disk and
 * references it as an ordinary markdown image - it has no way to upload, since
 * putting a 400KB image in a tool call means *emitting* half a million
 * characters of base64 - so the app takes the path it was given, copies the
 * bytes into its own store, and swaps the URL for a token. What the agent wrote
 * keeps working after /tmp is cleaned.
 *
 * Three decisions here are each easy to get wrong in a way that only shows up
 * later, so they are spelled out.
 *
 * **The markdown is parsed, not matched.** A regex over the body would happily
 * ingest the image in an agent's example markdown inside a fenced code block -
 * and agents write such examples constantly, including the one in this app's own
 * tool descriptions. A parser produces no image node inside a fence, so the
 * problem does not arise.
 *
 * **The original string is spliced, not re-serialised.** `mdast-util-to-markdown`
 * would round-trip the whole document and normalise it on the way out: bullet
 * markers, emphasis characters, line wrapping, escaping. The author here is
 * often an agent whose text a human will read and edit, and silently rewriting
 * prose that was never touched is exactly the drift this app avoids elsewhere.
 * So the node offsets are used to replace URLs in place, working backwards from
 * the last match so the earlier offsets stay valid. The body comes out
 * byte-identical apart from the URLs.
 *
 * **A path that does not resolve is left alone.** Failing the whole call would
 * throw away a body an agent spent real tokens composing, over a detail it can
 * neither see nor retry usefully - the same trade the composer already makes
 * for humans, where a failed submit keeps the typed text.
 */
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { visit } from 'unist-util-visit'
import { ATTACHMENT_URL_PREFIX, attachmentsService } from './services/attachments.js'

/** One image URL found in a body, with where it sits in the original string. */
interface FoundImage {
  url: string
  /** Offsets of the whole image node, from the parser. */
  start: number
  end: number
}

function collectImages(body: string): FoundImage[] {
  const tree = fromMarkdown(body)
  const found: FoundImage[] = []

  visit(tree, 'image', (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    // Without offsets there is nothing to splice. mdast always supplies them
    // for a parsed document; this is a type guard rather than a real case.
    if (start === undefined || end === undefined) return
    found.push({ url: node.url, start, end })
  })

  return found
}

/**
 * Turn an image URL into a path on this machine, or null if it is not one.
 *
 * Both spellings agents actually write are accepted: `file:///abs/path.png` and
 * a bare `/abs/path.png`. `file://` URLs are percent-decoded first, because a
 * screenshot called "Screen Shot 2026.png" arrives as `Screen%20Shot%202026.png`
 * and a filesystem has never heard of `%20`.
 *
 * Relative paths are refused rather than resolved: there is no working
 * directory that means anything here - the GUI's is wherever the app was
 * launched from, the MCP server's is the agent's - so guessing one would ingest
 * an unpredictable file.
 */
export function localPathFor(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url)
    } catch {
      return null
    }
  }

  // Any other scheme is remote, or at least not ours: http(s), data, and the
  // gitwarren tokens produced by an earlier pass through this function.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null

  const decoded = safeDecode(url)
  return isAbsolute(decoded) ? decoded : null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A stray `%` that is not an escape. Take the text as written.
    return value
  }
}

/**
 * True when `path` sits inside `root`.
 *
 * Files committed to the repository under review are left alone: rendering
 * those live is consistent with the app's read-from-git-every-time rule, and
 * copying one into the attachment store would freeze a picture of a file that
 * is under version control and expected to change. (Actually *rendering* them
 * is out of scope for now - such a URL simply stays as it is.)
 */
function isInsideRepository(path: string, repositoryRoot: string | null): boolean {
  if (repositoryRoot === null) return false
  const rel = relative(resolve(repositoryRoot), resolve(path))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface IngestBodyOptions {
  /**
   * The repository the comment belongs to. Paths inside it are left untouched;
   * null when the caller has no repository in hand, which just means nothing is
   * exempt.
   */
  repositoryRoot?: string | null
}

/**
 * Copy every local image a body references into the store, and rewrite its URL.
 *
 * Returns the new body. Identical to the input when there is nothing to do,
 * which is the overwhelmingly common case - so the fast path is one markdown
 * parse and no filesystem access at all.
 */
export async function ingestBodyAttachments(
  body: string,
  options: IngestBodyOptions = {}
): Promise<string> {
  const { repositoryRoot = null } = options

  // Cheap gate before parsing: no `![` means no image node, and every comment
  // in the app goes through here.
  if (!body.includes('![')) return body

  const images = collectImages(body)
  if (images.length === 0) return body

  const replacements: { start: number; end: number; url: string }[] = []

  for (const image of images) {
    const path = localPathFor(image.url)
    if (path === null) continue
    if (isInsideRepository(path, repositoryRoot)) continue

    try {
      const attachment = await attachmentsService.ingest({ path })
      replacements.push({ start: image.start, end: image.end, url: attachment.url })
    } catch {
      // Missing, unreadable, too large, or not an image. The comment is worth
      // more than the link: leave this URL as written and save the body.
    }
  }

  if (replacements.length === 0) return body

  // Backwards, so each splice leaves every earlier offset still valid.
  let rewritten = body
  for (const replacement of replacements.reverse()) {
    const node = rewritten.slice(replacement.start, replacement.end)
    // The node text is `![alt](url "title")`. Only the URL is replaced, and it
    // is located within the node rather than by rebuilding the node, so alt
    // text, titles and any unusual spacing survive exactly as written.
    const swapped = replaceUrlInImageNode(node, replacement.url)
    if (swapped === null) continue
    rewritten = rewritten.slice(0, replacement.start) + swapped + rewritten.slice(replacement.end)
  }

  return rewritten
}

/**
 * Swap the URL inside a single `![alt](url)` node, leaving everything else.
 *
 * Works on the node's own text rather than the whole document, so the bracket
 * matching only has to survive one node - which the parser has already told us
 * is a well-formed image.
 */
function replaceUrlInImageNode(node: string, url: string): string | null {
  const open = node.indexOf('](')
  if (open === -1 || !node.endsWith(')')) return null

  const inside = node.slice(open + 2, node.length - 1)
  // A title, if present, follows the URL after whitespace: `(url "title")`.
  // Angle-bracketed URLs (`(<url with spaces>)`) keep their brackets off, since
  // an attachment token never contains a space.
  const titleAt = inside.search(/\s+["'(]/)
  const title = titleAt === -1 ? '' : inside.slice(titleAt)

  return `${node.slice(0, open + 2)}${url}${title})`
}

/**
 * The attachment tokens a body refers to, with the alt text written for each.
 *
 * This is what fills the `attachments` array every comment carries. The alt
 * text comes along because it is the only description of an image that an agent
 * without vision ever gets - to such a reader, "dropdown behind modal" *is* the
 * picture.
 *
 * Parsed rather than matched, for the same reason the ingest path is: an image
 * inside a fenced code block is an example, not an attachment, and this app's
 * own tool descriptions contain exactly such an example.
 */
export function attachmentReferencesIn(body: string): { url: string; alt: string }[] {
  if (!body.includes(ATTACHMENT_URL_PREFIX)) return []

  const tree = fromMarkdown(body)
  const found: { url: string; alt: string }[] = []
  const seen = new Set<string>()

  visit(tree, 'image', (node) => {
    if (!node.url.startsWith(ATTACHMENT_URL_PREFIX) || seen.has(node.url)) return
    seen.add(node.url)
    found.push({ url: node.url, alt: node.alt ?? '' })
  })

  return found
}
