/**
 * A Markdown file read as a document rather than as source - with what changed
 * still on it.
 *
 * More and more of what gets reviewed here is not code. Agent instructions,
 * plans, specs, READMEs, and for some people whole books are Markdown, and
 * Markdown is written to be read rendered: reviewing a chapter as `**` and
 * `[^3]` and a paragraph-long line of green is reviewing the typesetting
 * instructions instead of the text. So a Markdown file in the diff can be
 * flipped to its preview, and the preview is not a plain render of the new
 * version - that would hide the very thing under review. Blocks that were added
 * are marked as added, removed ones as removed, and inside a paragraph that was
 * edited the changed words are struck out and picked out in place, the way a
 * tracked-changes view in a word processor shows them. See `markdown-diff.ts`
 * for how the two versions are compared.
 *
 * Side by side works here too, with the same switch as the diff: the old
 * document on the left and the new one on the right, block level with block.
 *
 * ## Commenting on a paragraph
 *
 * A comment in the preview is a comment on the block's lines - head side,
 * first line to last - made through exactly the same call a comment dragged
 * out over those lines in the diff would make. So it is anchored by the same
 * rules, an agent reads it the same way, and switching back to the diff shows
 * it against the source it was about. Threads already on those lines show up
 * under the block in the preview, so the discussion is never on the other side
 * of a toggle.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Eye, FileCode, MessageSquarePlus, UnfoldVertical } from 'lucide-react'
import type { Components } from 'react-markdown'
import { Markdown } from '@/components/markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import type { CommentMutations } from '../comments/use-comments'
import {
  definitionsOf,
  diffMarkdown,
  foldUnchanged,
  headFromPatch,
  markdownBlocks,
  markedSource,
  rebuildBase,
  type MarkdownBlock,
  type PreviewRow
} from './markdown-diff'
import { remarkChangeMarks } from './remark-change-marks'
import { useReviewFile, useReviewImage } from './use-reviews'
import type { DiffSide } from '@shared/comment-anchors'
import { imageMediaType } from '@shared/git'
import type { DiffChanges, FileDiff } from '@shared/git'
import type { AnchoredThread, DiffLayout } from './diff-view'

export type MarkdownView = 'diff' | 'preview'

/** Blocks of unchanged text kept either side of a change before the rest folds. */
const FOLD_CONTEXT = 2

const CHANGE_PLUGINS = [remarkChangeMarks]

/**
 * Which way a Markdown file is shown.
 *
 * The same segmented shape as the changes toggle in the files tab, small enough
 * to sit in a file's header. `labels` because the same choice reads differently
 * in two places: in the diff it is the change against the document, in the file
 * browser the source against the document.
 */
export function MarkdownViewToggle({
  view,
  onChange,
  sourceLabel = 'Diff'
}: {
  view: MarkdownView
  onChange: (next: MarkdownView) => void
  sourceLabel?: string
}) {
  const options: Array<{ value: MarkdownView; label: string; icon: ReactNode; title: string }> = [
    {
      value: 'diff',
      label: sourceLabel,
      icon: <FileCode />,
      title: `Show the Markdown source${sourceLabel === 'Diff' ? ' as a diff' : ''}`
    },
    {
      value: 'preview',
      label: 'Preview',
      icon: <Eye />,
      title: 'Show the document as it reads, rendered'
    }
  ]

  return (
    <div
      role="group"
      aria-label="How to show this Markdown file"
      className="flex shrink-0 items-center rounded-md border border-border p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={view === option.value}
          title={option.title}
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors [&_svg]:size-3.5',
            view === option.value
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.icon}
          <span className="max-sm:sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  )
}

/** What a preview needs in order to carry a discussion. */
export interface PreviewComments {
  reviewId: number
  threads: readonly AnchoredThread[]
  mutations: CommentMutations
  changes: DiffChanges
}

/**
 * Draws an image the document refers to by a path inside the repository.
 *
 * Supplied by whoever knows where the repository is - a review, or a
 * repository being browsed - because this component does not.
 */
export type ImageRenderer = (path: string, side: DiffSide, alt: string) => ReactNode

/** One file of a review's diff, previewed with its changes. */
export function MarkdownDiffPreview({
  file,
  reviewId,
  changes,
  layout,
  comments
}: {
  file: FileDiff
  reviewId: number
  changes: DiffChanges
  layout: DiffLayout
  comments: PreviewComments | undefined
}) {
  // A new or deleted file is in the patch whole; anything else needs the head
  // file read, which the diff's own expanders share through the same cache key.
  const fromPatch = useMemo(() => headFromPatch(file), [file])
  const text = useReviewFile(fromPatch === null ? reviewId : null, file.path, changes)
  const { load } = text
  useEffect(() => {
    if (fromPatch === null) load()
  }, [fromPatch, load])

  const headLines =
    fromPatch ?? (text.content && !text.content.isBinary && text.content.error === null ? text.content.lines : null)
  const rows = useMemo(() => {
    if (headLines === null) return null
    const base = rebuildBase(file, headLines)
    return base === null ? null : diffMarkdown(base, headLines)
  }, [file, headLines])

  const renderImage = useReviewImages(reviewId, changes)

  if (rows === null) {
    const problem =
      file.truncated
        ? 'This file is too large for the diff to show in full, so it cannot be previewed with its changes.'
        : text.content?.error ?? (text.error === undefined ? null : errorMessage(text.error))
    if (problem !== null || (text.content !== undefined && headLines !== null)) {
      return (
        <p className="p-3 text-xs text-muted-foreground">
          {problem ?? 'The file changed on disk while it was being read. Refresh to preview it.'}
        </p>
      )
    }
    return <PreviewSkeleton />
  }

  return (
    <PreviewDocument
      rows={rows}
      layout={layout}
      fold
      filePath={file.path}
      comments={comments}
      renderImage={renderImage}
    />
  )
}

/**
 * A whole file, rendered, with nothing to compare it to - the file browser's
 * preview.
 */
export function MarkdownFilePreview({
  lines,
  filePath,
  comments,
  renderImage
}: {
  lines: readonly string[]
  filePath: string
  comments?: PreviewComments
  renderImage?: ImageRenderer
}) {
  const rows = useMemo<PreviewRow[]>(
    () => markdownBlocks(lines).map((block) => ({ kind: 'same', before: block, after: block })),
    [lines]
  )
  return (
    <PreviewDocument
      rows={rows}
      layout="unified"
      fold={false}
      filePath={filePath}
      comments={comments}
      renderImage={renderImage}
    />
  )
}

/** Images from the review's own repository, each side from its own version. */
export function useReviewImages(reviewId: number, changes: DiffChanges): ImageRenderer {
  return useMemo<ImageRenderer>(
    () =>
      function ReviewImage(path, side, alt) {
        return <ReviewImageView reviewId={reviewId} changes={changes} path={path} side={side} alt={alt} />
      },
    [reviewId, changes]
  )
}

function ReviewImageView({
  reviewId,
  changes,
  path,
  side,
  alt
}: {
  reviewId: number
  changes: DiffChanges
  path: string
  side: DiffSide
  alt: string
}) {
  const { image, isLoading } = useReviewImage(reviewId, path, side, changes)
  return <DocumentImage dataUrl={image?.dataUrl ?? null} error={image?.error ?? null} loading={isLoading} path={path} alt={alt} />
}

/** An image drawn from the repository, or a quiet note saying why it is not. */
export function DocumentImage({
  dataUrl,
  error,
  loading,
  path,
  alt
}: {
  dataUrl: string | null
  error: string | null
  loading: boolean
  path: string
  alt: string
}) {
  if (dataUrl !== null) {
    return <img src={dataUrl} alt={alt} className="my-2 inline-block max-w-full rounded-md border border-border" />
  }
  if (loading) return <Skeleton className="my-2 inline-block h-24 w-40 align-top" />
  return (
    <span
      data-selectable
      title={error ?? undefined}
      className="inline-flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
    >
      {alt.length > 0 ? `${alt} — ` : ''}
      {path}
    </span>
  )
}

/**
 * Where a relative image path in a document lands in the repository, or null
 * when it is not one: a URL, an absolute path, an attachment token, or a path
 * that climbs out of the repository.
 */
export function resolveDocumentPath(documentPath: string, src: string): string | null {
  if (src === '' || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) {
    return null
  }
  const clean = decodeURI(src.split(/[?#]/)[0] ?? '')
  const parts = documentPath.split('/').slice(0, -1)
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** The block's source as it is handed to the renderer. */
function renderable(block: MarkdownBlock, source: string, definitions: string): string {
  if (block.kind === 'frontmatter') {
    // Front matter is YAML, not Markdown; shown as what it is.
    const inner = source.split('\n').slice(1, -1).join('\n')
    return `\`\`\`yaml\n${inner}\n\`\`\``
  }
  return definitions === '' ? source : `${source}\n\n${definitions}`
}

/**
 * The typography of a document, over the comment-sized defaults in
 * `components/markdown.tsx`.
 *
 * Written as descendant selectors so they outrank the per-element classes
 * there without a second set of components. A chapter wants headings that look
 * like headings and a line length and leading that can be read for an hour; a
 * comment wants neither.
 */
const DOCUMENT_TYPE = cn(
  'text-[0.9375rem] leading-7',
  '[&_p]:leading-7 [&_li]:leading-7',
  '[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight',
  '[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight',
  '[&_h3]:text-lg [&_h4]:text-base',
  '[&_blockquote]:italic'
)

function BlockBody({
  block,
  source,
  marked,
  definitions,
  overrides,
  className
}: {
  block: MarkdownBlock
  source: string
  marked: boolean
  definitions: string
  overrides: Partial<Components> | undefined
  className?: string
}) {
  return (
    <Markdown
      body={renderable(block, source, definitions)}
      remarkPlugins={marked ? CHANGE_PLUGINS : undefined}
      overrides={overrides}
      className={cn(DOCUMENT_TYPE, block.kind === 'heading' && 'pt-3', className)}
    />
  )
}

/** The `img` override for one side of the document, or none to keep links. */
function useImageOverrides(
  filePath: string,
  side: DiffSide,
  renderImage: ImageRenderer | undefined
): Partial<Components> | undefined {
  return useMemo(() => {
    if (renderImage === undefined) return undefined
    const img: Components['img'] = ({ src, alt }) => {
      const url = typeof src === 'string' ? src : ''
      const path = resolveDocumentPath(filePath, url)
      if (path === null || imageMediaType(path) === null) {
        // The same answer the comment renderer gives a URL it will not fetch:
        // the reference, visible, as a link.
        return (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline underline-offset-2 hover:no-underline"
          >
            {alt && alt.length > 0 ? alt : url}
          </a>
        )
      }
      return renderImage(path, side, alt ?? '')
    }
    return { img }
  }, [filePath, side, renderImage])
}

/** Where a comment on a row goes: the block's lines, on the side it lives on. */
function rowAddress(row: PreviewRow): { side: DiffSide; block: MarkdownBlock } {
  return row.kind === 'removed' ? { side: 'base', block: row.before } : { side: 'head', block: row.after }
}

/**
 * Which row each thread belongs under: the last block on its side that starts
 * at or before the thread's line. A thread on a blank line between paragraphs
 * goes with the paragraph above it, which is the one it was most likely about.
 */
function threadsByRow(
  rows: readonly PreviewRow[],
  threads: readonly AnchoredThread[]
): Map<number, AnchoredThread[]> {
  const byRow = new Map<number, AnchoredThread[]>()
  for (const thread of threads) {
    const line = thread.anchor.line
    if (line === null || thread.side === null) continue
    let found = -1
    for (const [index, row] of rows.entries()) {
      // A base-side thread is on a removed line, which only removed and edited
      // blocks still have.
      const block =
        thread.side === 'head'
          ? row.kind === 'removed'
            ? null
            : row.after
          : row.kind === 'removed' || row.kind === 'changed'
            ? row.before
            : null
      if (block !== null && block.start <= line) found = index
    }
    if (found === -1) continue
    const existing = byRow.get(found)
    if (existing) existing.push(thread)
    else byRow.set(found, [thread])
  }
  return byRow
}

function PreviewDocument({
  rows,
  layout,
  fold,
  filePath,
  comments,
  renderImage
}: {
  rows: readonly PreviewRow[]
  layout: DiffLayout
  fold: boolean
  filePath: string
  comments: PreviewComments | undefined
  renderImage: ImageRenderer | undefined
}) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set())
  const [composingOn, setComposingOn] = useState<number | null>(null)

  const definitionsBefore = useMemo(
    () => definitionsOf(rows.flatMap((row) => (row.kind === 'added' ? [] : [row.before]))),
    [rows]
  )
  const definitionsAfter = useMemo(
    () => definitionsOf(rows.flatMap((row) => (row.kind === 'removed' ? [] : [row.after]))),
    [rows]
  )
  const beforeImages = useImageOverrides(filePath, 'base', renderImage)
  const afterImages = useImageOverrides(filePath, 'head', renderImage)

  const placed = useMemo(
    () => (comments === undefined ? new Map<number, AnchoredThread[]>() : threadsByRow(rows, comments.threads)),
    [rows, comments]
  )
  const keep = useMemo(() => {
    const indices = new Set(placed.keys())
    if (composingOn !== null) indices.add(composingOn)
    return indices
  }, [placed, composingOn])

  const visible = useMemo(
    () =>
      fold
        ? foldUnchanged(rows, FOLD_CONTEXT, opened, keep)
        : rows.map((row, index) => ({ kind: 'row' as const, row, index })),
    [fold, rows, opened, keep]
  )

  const changed = rows.filter((row) => row.kind !== 'same').length
  const split = layout === 'split'

  const side = (row: PreviewRow, version: 'before' | 'after'): ReactNode => {
    const block = version === 'before' ? (row.kind === 'added' ? null : row.before) : row.kind === 'removed' ? null : row.after
    // The same muted strip the side-by-side diff draws opposite a lone line,
    // the full height of the block on the other side.
    if (block === null) return <div className="h-full min-h-8 bg-muted/40" aria-hidden />
    const isChange = row.kind === 'changed'
    const tone =
      row.kind === 'added' || (isChange && version === 'after')
        ? 'border-l-4 border-success/70 bg-success/5'
        : row.kind === 'removed' || (isChange && version === 'before')
          ? 'border-l-4 border-destructive/70 bg-destructive/5'
          : 'border-l-4 border-transparent'
    return (
      <BlockBody
        block={block}
        source={isChange ? markedSource(row.words, version) : block.text}
        marked={isChange}
        definitions={version === 'before' ? definitionsBefore : definitionsAfter}
        overrides={version === 'before' ? beforeImages : afterImages}
        className={cn(
          'h-full px-4 py-1.5',
          tone,
          // A removed block is struck through as a whole; inside an edited one
          // only the removed words are.
          row.kind === 'removed' && 'text-muted-foreground line-through decoration-destructive/50'
        )}
      />
    )
  }

  return (
    <div className="flex flex-col py-2" data-selectable>
      {fold && (
        <p className="px-4 pb-2 font-sans text-xs text-muted-foreground">
          {changed === 0
            ? 'Nothing a reader would see has changed — the edits are in whitespace.'
            : `${plural(changed, 'block')} changed. Added text is highlighted, removed text struck through.`}
        </p>
      )}

      {visible.map((entry) => {
        if (entry.kind === 'fold') {
          return (
            <button
              key={`fold-${entry.from}`}
              type="button"
              onClick={() => setOpened((current) => new Set(current).add(entry.from))}
              className="my-1 flex items-center gap-2 bg-muted/60 px-4 py-1 text-left font-sans text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <UnfoldVertical className="size-3.5" />
              Show {plural(entry.count, 'unchanged block')}
            </button>
          )
        }

        const { row, index } = entry
        const address = rowAddress(row)
        const threads = placed.get(index) ?? []
        const composing = composingOn === index
        const range =
          address.block.start === address.block.end
            ? `line ${address.block.start}`
            : `lines ${address.block.start}–${address.block.end}`
        const commentButton = comments && (
          <button
            type="button"
            onClick={() => setComposingOn(composing ? null : index)}
            title={`Comment on ${range}`}
            aria-label="Comment on this block"
            className={cn(
              'absolute top-1 z-10 flex size-6 items-center justify-center rounded-md bg-card text-muted-foreground shadow-sm ring-1 ring-border transition-colors hover:bg-primary hover:text-primary-foreground [&_svg]:size-3.5',
              // In the side-by-side view the button sits on the half the
              // comment will be about.
              split && address.side === 'base' ? 'right-[calc(50%+0.5rem)]' : 'right-2',
              // Shown on hover where hovering exists, always on a touch screen
              // - the same rule as the diff's own comment button.
              composing ? 'flex' : '[@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:flex'
            )}
          >
            <MessageSquarePlus />
          </button>
        )

        return (
          <div key={index} className="group relative">
            {split ? (
              <div className="grid grid-cols-2 gap-x-1">
                <div className="min-w-0">{side(row, 'before')}</div>
                <div className="min-w-0">{side(row, 'after')}</div>
              </div>
            ) : (
              // Positioned, so the comment button sits at the edge of the text
              // column rather than out at the far edge of a wide card.
              <div className="relative mx-auto w-full max-w-3xl">
                {commentButton}
                {row.kind === 'changed' ? (
                  <BlockBody
                    block={row.after}
                    source={markedSource(row.words, 'merged')}
                    marked
                    definitions={definitionsAfter}
                    overrides={afterImages}
                    className="border-l-4 border-warning/70 bg-warning/5 px-4 py-1.5"
                  />
                ) : row.kind === 'removed' ? (
                  side(row, 'before')
                ) : (
                  side(row, 'after')
                )}
              </div>
            )}

            {split && commentButton}

            {comments && (threads.length > 0 || composing) && (
              <div
                className={cn(
                  'my-1 flex flex-col gap-2 border-y border-border bg-muted/20 p-3 font-sans text-sm',
                  split ? (address.side === 'base' ? 'mr-[50%]' : 'ml-[50%]') : 'mx-auto w-full max-w-3xl'
                )}
              >
                {threads.map((thread) => (
                  <CommentThreadCard
                    key={thread.id}
                    thread={thread}
                    mutations={comments.mutations}
                    anchorState={thread.anchor.state}
                    location={
                      thread.anchor.startLine !== null && thread.anchor.line !== null ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          lines {thread.anchor.startLine}–{thread.anchor.line}
                        </span>
                      ) : thread.anchor.line !== null ? (
                        <span className="font-mono text-xs text-muted-foreground">line {thread.anchor.line}</span>
                      ) : null
                    }
                  />
                ))}
                {composing && (
                  <div className="rounded-lg border border-border bg-card p-3">
                    <CommentComposer
                      autoFocus
                      placeholder={`Comment on ${range}`}
                      onCancel={() => setComposingOn(null)}
                      onSubmit={async (body) => {
                        await comments.mutations.createThread({
                          reviewId: comments.reviewId,
                          body,
                          filePath,
                          side: address.side,
                          line: address.block.end,
                          changes: comments.changes,
                          ...(address.block.start < address.block.end ? { startLine: address.block.start } : {})
                        })
                        setComposingOn(null)
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function PreviewSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 p-4" aria-busy="true" aria-label="Rendering the document">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  )
}
