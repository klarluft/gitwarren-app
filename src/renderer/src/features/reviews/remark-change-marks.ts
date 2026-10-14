/**
 * Turn the change marks `markdown-diff.ts` put into a block's source into
 * `<ins>` and `<del>` elements, after the source has been parsed.
 *
 * The marks are private-use characters wrapped around changed words. By the
 * time the parser is done they sit inside text nodes - possibly an opening mark
 * in one text node and its closing mark in another, with a `**bold**` between
 * them - so the tree is walked in reading order with the current state carried
 * across nodes, and every stretch of text inside a mark is wrapped on its own.
 * One changed phrase that spans plain and bold text becomes two wrapped pieces
 * that read as one.
 *
 * The wrapper is a node type mdast does not know, carrying `data.hName`: that
 * is how `mdast-util-to-hast` is told which element to make of it, with no
 * `rehype-raw` and no HTML string anywhere - see `components/markdown.tsx` on
 * why raw HTML is never rendered.
 *
 * Marks that end up where text cannot be wrapped - the value of an inline code
 * span, which is one token and so is marked whole from outside - are simply
 * removed, so a stray one can never show up as a box in the reader's text.
 */
import type { Nodes, Parent, Root, Text } from 'mdast'
import { SENTINELS } from './markdown-diff'

type Mark = 'insert' | 'delete' | null

const ANY_SENTINEL = /[-]/
const SPLIT = /([-])/

function stateAfter(sentinel: string, state: Mark): Mark {
  switch (sentinel) {
    case SENTINELS.insertOpen:
      return 'insert'
    case SENTINELS.deleteOpen:
      return 'delete'
    case SENTINELS.insertClose:
    case SENTINELS.deleteClose:
      return null
    default:
      return state
  }
}

/** The class names an `<ins>` or `<del>` is drawn with. */
export const CHANGE_CLASSES = {
  insert: 'rounded-sm bg-success/20 text-inherit no-underline decoration-success',
  delete: 'rounded-sm bg-destructive/15 text-muted-foreground line-through decoration-destructive/70'
} as const

function wrapNode(node: Nodes, mark: 'insert' | 'delete'): Nodes {
  return {
    // Not an mdast type, and not meant to be one: see the note at the top.
    type: 'changeMark',
    data: {
      hName: mark === 'insert' ? 'ins' : 'del',
      hProperties: { className: CHANGE_CLASSES[mark] }
    },
    children: [node]
  } as unknown as Nodes
}

function wrap(value: string, mark: 'insert' | 'delete'): Nodes {
  return wrapNode({ type: 'text', value }, mark)
}

function strip(value: string): string {
  return value.replace(/[-]/g, '')
}

export function remarkChangeMarks() {
  return (tree: Root): void => {
    let state: Mark = null

    const visit = (parent: Parent): void => {
      const next: Nodes[] = []
      for (const child of parent.children as Nodes[]) {
        if (child.type === 'text') {
          if (!ANY_SENTINEL.test(child.value) && state === null) {
            next.push(child)
            continue
          }
          for (const piece of child.value.split(SPLIT)) {
            if (piece === '') continue
            if (ANY_SENTINEL.test(piece)) {
              state = stateAfter(piece, state)
              continue
            }
            next.push(state === null ? ({ type: 'text', value: piece } satisfies Text) : wrap(piece, state))
          }
          continue
        }
        if (child.type === 'inlineCode' || child.type === 'code' || child.type === 'html') {
          child.value = strip(child.value)
          // A code span inside a marked phrase is part of the change; it cannot
          // be wrapped from inside, so it is wrapped from outside.
          next.push(state === null || child.type !== 'inlineCode' ? child : wrapNode(child, state))
          continue
        }
        if (child.type === 'image') {
          child.alt = child.alt === null || child.alt === undefined ? child.alt : strip(child.alt)
          child.url = strip(child.url)
          // A picture that was added or removed is marked like a word was.
          next.push(state === null ? child : wrapNode(child, state))
          continue
        }
        if (child.type === 'link' || child.type === 'definition') child.url = strip(child.url)
        if ('children' in child) visit(child)
        next.push(child)
      }
      parent.children = next as Parent['children']
    }

    visit(tree)
  }
}
