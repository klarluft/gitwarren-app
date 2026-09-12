/**
 * One file of a review, whole, with the same comment gutter the diff has.
 *
 * This is the browse tab's counterpart to `FileDiffCard`, and the reason it is
 * a separate component rather than a mode of that one is that the two are
 * answering different questions. A diff card is about a *change*: it has two
 * sides, a status, a line count that changed, a reviewed tick that means "I
 * have read this change". A file has none of that. It is one version of one
 * document, and dressing it up as a patch with no hunks would mean a card that
 * spends most of its code explaining which of its own affordances do not apply.
 *
 * What the two do share is the part that matters: a row of code with a `+` in
 * its gutter, and what happens when you drag that `+` down five lines.
 * `LineRow` and `useLineSelection` are both used verbatim here, so a comment
 * left on an unchanged file is made with the same gesture, drawn in the same
 * place, and stored through the same call as one left on a diff.
 *
 * ## Lines, not hunks
 *
 * The file arrives as `FileContent` - the same read the diff's expanders make -
 * and each line becomes a `DiffLine` of type `context` numbered on the head
 * side only. `oldNumber` is deliberately null: `rowPosition` then reports every
 * row as head-side, which is what a file that is not being compared to anything
 * actually is, and the base-side gutter draws blank instead of repeating the
 * same number twice.
 */
import { useEffect, useMemo } from 'react'
import { FileWarning } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { CopyPathAction, IconAction, LineRow, type DiffComments, type RowContext } from './diff-view'
import { FilePath } from './file-path'
import { ImagePane } from './image-diff'
import { useLineSelection } from './line-selection'
import { useReviewFile } from './use-reviews'
import { SquareArrowOutUpRight } from 'lucide-react'
import { resolveAnchorInFile } from '@shared/comment-anchors'
import { imageMediaType } from '@shared/git'
import type { DiffChanges, DiffLine } from '@shared/git'
import type { CommentThread } from '@shared/schemas'
import type { AnchoredThread } from './diff-view'

/**
 * Past this the file is shown but the browser is not asked to lay out every
 * line of it at once.
 *
 * `readReviewFile` already refuses anything past 20,000 lines, so this is about
 * what a *DOM* will take rather than what a pipe will: each row is a grid of
 * three elements plus a hover button, and a generated bundle or a lockfile will
 * happily hit six figures of them. The file is still readable to the ceiling,
 * and the card says where it stopped - which is a great deal more use than a
 * tab that goes unresponsive for nine seconds.
 */
const MAX_RENDERED_LINES = 5_000

export interface FileSourceCardProps {
  reviewId: number
  path: string
  /** Which version of the file to read - as always, the diff's own setting. */
  changes: DiffChanges
  /** Threads stored against this path, not yet placed against the text. */
  threads: CommentThread[]
  comments: Omit<DiffComments, 'threads'>
  /** True when this file is part of the review's diff, so the card can say so. */
  isChanged: boolean
  /** A line arrived at from a link, marked while the reader finds it. */
  marked?: { side: 'base' | 'head'; line: number }
  editorLabel?: string | null
  onOpenInEditor?: (path: string, line: number) => void
}

export function FileSourceCard({
  reviewId,
  path,
  changes,
  threads,
  comments,
  isChanged,
  marked,
  editorLabel,
  onOpenInEditor
}: FileSourceCardProps) {
  const text = useReviewFile(reviewId, path, changes)
  const selection = useLineSelection()

  // Unlike the diff's expanders, which read a file only once somebody asks for
  // more context, the whole point of this screen is the file - so it is asked
  // for as soon as the card exists.
  const { load } = text
  useEffect(() => load(), [load])

  const content = text.content
  const lines = content?.lines

  /**
   * Where each thread lands in the text on screen.
   *
   * Run here against the file the reader is looking at, for exactly the reason
   * the files tab runs `resolveAnchor` against the diff on screen rather than
   * trusting one the main process read a moment later: a comment must never be
   * placed against a version of the file nobody is being shown.
   */
  const anchored = useMemo<AnchoredThread[]>(
    () =>
      threads.map((thread) => ({
        ...thread,
        anchor: resolveAnchorInFile(lines, {
          filePath: path,
          // `isInlineAnchor` is what put these threads in this list, so both
          // are set; the fallbacks satisfy the types without inventing a
          // position for a thread that has none.
          side: thread.side ?? 'head',
          line: thread.line ?? 0,
          startLine: thread.startLine,
          anchorText: thread.anchorText
        })
      })),
    [threads, lines, path]
  )

  const placed = useMemo(() => {
    const map = new Map<string, AnchoredThread[]>()
    for (const thread of anchored) {
      if (thread.anchor.line === null || thread.side === null) continue
      const key = `${thread.side}:${thread.anchor.line}`
      const existing = map.get(key)
      if (existing) existing.push(thread)
      else map.set(key, [thread])
    }
    return map
  }, [anchored])

  /** Every line a thread's range covers, so a block comment shows its reach. */
  const covered = useMemo(() => {
    const all = new Set<string>()
    for (const thread of anchored) {
      const { line, startLine } = thread.anchor
      if (line === null || startLine === null || thread.side === null) continue
      for (let current = startLine; current <= line; current += 1) {
        all.add(`${thread.side}:${current}`)
      }
    }
    return all
  }, [anchored])

  const rows: DiffLine[] = useMemo(
    () =>
      (lines ?? []).slice(0, MAX_RENDERED_LINES).map((line, index) => ({
        type: 'context',
        content: line,
        // Null on purpose - see the note at the top of this file.
        oldNumber: null,
        newNumber: index + 1
      })),
    [lines]
  )

  const rowContext: RowContext = {
    placed,
    comments: { ...comments, threads: anchored },
    composingOn: selection.composingOn,
    onCompose: selection.setComposingOn,
    onSelectStart: selection.startSelection,
    onSelectOver: selection.dragOver,
    selection: selection.selection,
    covered,
    marked: marked ?? null,
    filePath: path,
    search: null,
    // A file has one set of line numbers; the diff's second gutter would be a
    // column of nothing down the whole document.
    oneGutter: true
  }

  const orphans = anchored.filter((thread) => thread.anchor.line === null)
  const unresolved = anchored.filter((thread) => thread.resolvedAt === null).length
  const problem = content?.error ?? (text.error === undefined ? null : errorMessage(text.error))
  const isImage = (content?.isBinary ?? false) && imageMediaType(path) !== null
  const clipped = (lines?.length ?? 0) > MAX_RENDERED_LINES

  return (
    <Card className="overflow-clip">
      <div
        className={cn(
          // Sticky for the same reason the diff card's header is: a file taller
          // than the window should never leave the reader wondering which file
          // they are in.
          'sticky top-[var(--diff-sticky-top,0px)] z-10 flex w-full flex-wrap items-center gap-1',
          'border-b border-border bg-card px-3 py-2'
        )}
      >
        <span data-selectable className="min-w-0 grow basis-64 font-mono text-xs">
          <FilePath path={path} />
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2 pl-2">
          {isChanged && (
            // Worth saying plainly. A file open in this tab looks the same
            // whether or not the branch touched it, and "this one is in the
            // diff" is the difference between browsing and reviewing.
            <Badge variant="outline">In this diff</Badge>
          )}
          {content?.source === 'commit' && (
            <Badge variant="outline" title="Read from the head commit, not from a working tree.">
              committed
            </Badge>
          )}
          {anchored.length > 0 && (
            <Badge variant={unresolved > 0 ? 'default' : 'outline'}>
              {unresolved > 0 ? `${unresolved} unresolved` : `${anchored.length} resolved`}
            </Badge>
          )}
          <CopyPathAction path={path} />
          {onOpenInEditor && (
            <IconAction
              label={editorLabel ? `Open in ${editorLabel}` : 'Open in your editor'}
              onClick={() => onOpenInEditor(path, 1)}
              icon={<SquareArrowOutUpRight />}
            />
          )}
        </div>
      </div>

      {/* Threads that cannot be pinned to a line of this file: the code they
          were about has been rewritten since. Listed rather than dropped, for
          the same reason the files tab lists its orphans - a discussion that
          disappears because the code moved is the failure this app must not
          have. */}
      {orphans.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            {orphans.length === 1 ? 'A comment' : `${orphans.length} comments`} on code that is no
            longer in this file.
          </p>
          {orphans.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              mutations={comments.mutations}
              anchorState={thread.anchor.state}
              location={
                thread.line === null ? null : (
                  <span className="font-mono text-xs text-muted-foreground">
                    was line {thread.line}
                  </span>
                )
              }
            />
          ))}
        </div>
      )}

      {problem !== null ? (
        <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
          <FileWarning className="size-4 shrink-0 text-warning" />
          {problem}
        </p>
      ) : isImage ? (
        <div className="p-3">
          <ImagePane
            reviewId={reviewId}
            path={path}
            side="head"
            changes={changes}
            renamedFrom={null}
          />
        </div>
      ) : content?.isBinary ? (
        <p className="p-3 text-xs text-muted-foreground">
          This is a binary file. There is nothing to show and nothing to comment on.
        </p>
      ) : text.isLoading || content === undefined ? (
        <div className="flex flex-col gap-1 p-3">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : rows.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">This file is empty.</p>
      ) : (
        <div
          className={cn('@container overflow-x-auto', selection.isDragging && 'select-none')}
        >
          <div className="min-w-max font-mono text-xs leading-5">
            {rows.map((line) => (
              <LineRow key={line.newNumber} line={line} {...rowContext} />
            ))}
          </div>
        </div>
      )}

      {(clipped || content?.truncated === true) && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {content?.truncated === true
            ? 'This file is longer than GitWarren will read; the rest is not shown.'
            : `Only the first ${MAX_RENDERED_LINES.toLocaleString()} lines are shown.`}
        </p>
      )}
    </Card>
  )
}
