/**
 * Two remark plugins for a Markdown *document* - a file in the repository read
 * rendered - that a comment never needs.
 *
 * ## Headings get ids
 *
 * So a link to `#installation`, or to `guide.md#installation` from another
 * file, has somewhere to land. The id is GitHub's slug of the heading's text,
 * because those are the anchors people write links against, behind a prefix so
 * a heading called "root" can never collide with an id the app itself uses.
 * The preview renders each block on its own, so two headings with the same
 * text share an id rather than getting GitHub's `-1` suffix; a link to the
 * first of them still lands on the first.
 *
 * ## `<img>` and `<a>` tags become images and links
 *
 * READMEs are full of `<p align="center"><img src="docs/logo.png"></p>` and
 * `<a href="…"><img …></a>`, because Markdown has no way to size or centre a
 * picture. Raw HTML is never rendered here - see `components/markdown.tsx` -
 * so those showed up as the tags themselves, as text, which reads as a broken
 * preview rather than as a policy. The tags are therefore not rendered but
 * *read*: an image's `src`, `alt` and pixel `width` become an ordinary Markdown
 * image, a link's `href` an ordinary link, and from there they go through
 * exactly the same overrides as `![alt](src)` and `[text](href)` - a repository
 * file is drawn or opened, anything else is a link to the browser. Every other
 * attribute is dropped, and every other tag is left as the text it was.
 */
import type { Image, Link, Nodes, Paragraph, Parent, PhrasingContent, Root } from 'mdast'

/** The prefix on every heading id, and on every lookup of one. */
export const HEADING_ID_PREFIX = 'doc-'

/** GitHub's anchor for a heading: lower case, punctuation gone, spaces dashed. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

/** The DOM id a link to `#fragment` is looking for. */
export function headingDomId(fragment: string): string {
  let decoded = fragment
  try {
    decoded = decodeURIComponent(fragment)
  } catch {
    // A stray `%` - use the fragment as written.
  }
  return HEADING_ID_PREFIX + decoded.toLowerCase()
}

function textOf(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string' && node.type !== 'html') return node.value
  if ('children' in node) return node.children.map((child) => textOf(child as Nodes)).join('')
  return ''
}

function forEachNode(node: Nodes, visit: (node: Nodes, parent: Parent | null) => void, parent: Parent | null = null): void {
  visit(node, parent)
  if ('children' in node) {
    // Copied, because a visit may replace children of this node.
    for (const child of [...node.children]) forEachNode(child, visit, node)
  }
}

export function remarkHeadingIds() {
  return (tree: Root): void => {
    forEachNode(tree, (node) => {
      if (node.type !== 'heading') return
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, id: HEADING_ID_PREFIX + headingSlug(textOf(node)) }
      }
    })
  }
}

/** The three tags read out of HTML: a link opening, a link closing, an image. */
const MEDIA_TAG = /<a\b[^>]*>|<\/a\s*>|<img\b[^>]*>/gi

/** Parents whose children are blocks, so an image needs a paragraph in them. */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (match === null) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

type MediaToken = { kind: 'open'; href: string | null } | { kind: 'close' } | { kind: 'image'; image: Image }

/** The links and images an HTML fragment names, in order, and nothing else of it. */
function mediaIn(html: string): MediaToken[] {
  const tokens: MediaToken[] = []
  for (const tag of html.match(MEDIA_TAG) ?? []) {
    if (/^<\/a/i.test(tag)) {
      tokens.push({ kind: 'close' })
    } else if (/^<a/i.test(tag)) {
      const href = attribute(tag, 'href')
      tokens.push({ kind: 'open', href: href === null || href === '' ? null : href })
    } else {
      const src = attribute(tag, 'src')
      if (src === null || src === '') continue
      // `width` is the one attribute kept besides `src` and `alt`, and only as
      // a number of pixels: it is how a README draws a logo at logo size.
      const width = /^\s*(\d+)(px)?\s*$/i.exec(attribute(tag, 'width') ?? '')?.[1]
      tokens.push({
        kind: 'image',
        image: {
          type: 'image',
          url: src,
          alt: attribute(tag, 'alt') ?? '',
          title: null,
          ...(width === undefined ? {} : { data: { hProperties: { width: Number(width) } } })
        }
      })
    }
  }
  return tokens
}

/**
 * A run of phrasing content with its HTML links and images made real.
 *
 * Walked as a stream rather than node by node, because CommonMark splits
 * `<a href="…"><img …></a>` in a paragraph into three separate HTML nodes, and
 * whatever sits between the opening and closing tag - an image, or plain
 * Markdown text - belongs inside the link. An `<a>` with no `href` (the old
 * `<a name="top">` anchor) is dropped, and a link left open at the end is
 * closed there. HTML holding none of the three tags is left exactly as it was.
 */
function rewritePhrasing(children: readonly Nodes[]): { nodes: Nodes[]; changed: boolean } {
  const out: Nodes[] = []
  let link: Link | null = null
  let changed = false
  const push = (node: Nodes): void => {
    if (link === null) out.push(node)
    else link.children.push(node as PhrasingContent)
  }
  for (const child of children) {
    const tokens = child.type === 'html' ? mediaIn(child.value) : []
    if (tokens.length === 0) {
      push(child)
      continue
    }
    changed = true
    for (const token of tokens) {
      if (token.kind === 'image') {
        push(token.image)
      } else if (token.kind === 'close') {
        if (link !== null) out.push(link)
        link = null
      } else {
        if (link !== null) out.push(link)
        link = token.href === null ? null : { type: 'link', url: token.href, title: null, children: [] }
      }
    }
  }
  if (link !== null) out.push(link)
  return { nodes: out, changed }
}

/** The images an HTML fragment names, as a test can see them. */
export function imagesInHtml(html: string): Image[] {
  return mediaIn(html).flatMap((token) => (token.kind === 'image' ? [token.image] : []))
}

export function remarkHtmlImages() {
  return (tree: Root): void => {
    forEachNode(tree, (node) => {
      if (!('children' in node)) return
      const parent = node as Parent
      if (BLOCK_PARENTS.has(parent.type)) {
        // A block of HTML - `<p align="center"><img …></p>` - is one node, and
        // only the images in it (and links around them) are kept; an image is
        // phrasing content, so it gets a paragraph to sit in.
        parent.children = parent.children.flatMap((child) => {
          if (child.type !== 'html' || imagesInHtml(child.value).length === 0) return [child]
          const { nodes } = rewritePhrasing([child])
          return [{ type: 'paragraph', children: nodes as PhrasingContent[] } satisfies Paragraph]
        })
        return
      }
      if (!parent.children.some((child) => child.type === 'html')) return
      const { nodes, changed } = rewritePhrasing(parent.children)
      if (changed) parent.children = nodes as typeof parent.children
    })
  }
}
