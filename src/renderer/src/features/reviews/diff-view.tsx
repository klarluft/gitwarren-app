/**
 * GitHub-style rendering of a parsed diff, with the discussion in it.
 *
 * Layout notes worth keeping:
 *  - Each line is a three-column grid (old number, new number, content) rather
 *    than a table, so the two gutters can stay pinned while long lines scroll
 *    horizontally inside their own container - the page itself never scrolls
 *    sideways.
 *  - Whitespace is preserved with `whitespace-pre`, because in a diff the
 *    indentation *is* the content.
 *  - Very large files start collapsed. The reviewer opens what they care about,
 *    and a vendored bundle does not cost a thousand DOM nodes on arrival.
 *
 * The lines between the hunks can be unfolded, the way they can on GitHub. That
 * costs one read of the whole file, done lazily the first time the reviewer
 * asks and then reused for every later expansion of the same file - see
 * `useReviewFile`. Unfolded lines are ordinary context rows, which means a
 * comment can be left on one exactly as on any other line.
 *
 * Comments are threaded in against the diff *currently on screen*, using the
 * anchors resolved by `shared/comment-anchors`. A thread whose line has moved
 * follows the code; one whose line is gone is listed above the file rather than
 * dropped, because a comment the reader cannot find is worse than a comment
 * shown slightly out of place. A file with a collapsed body still shows its
 * comment count, so a discussion is never hidden behind a fold.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleDot,
  Copy,
  FileDiff as FileDiffIcon,
  FileMinus,
  FilePlus,
  FileSymlink,
  MessageSquare,
  Plus,
  SquareArrowOutUpRight,
  UnfoldVertical
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { DiffSnippet } from './diff-snippet'
import { FilePath } from './file-path'
import { ImageDiff } from './image-diff'
import { ACTIVE_MATCH_ID, lineDomId } from './dom-ids'
import { useReviewFile } from './use-reviews'
import type { CommentMutations } from '../comments/use-comments'
import { threadSnippet } from '@shared/comment-snippets'
import type { DiffSide, ResolvedAnchor } from '@shared/comment-anchors'
import {
  continuesFromAbove,
  fileGaps,
  segmentGap,
  type DiffGap,
  type GapSegment
} from '@shared/diff-gaps'
import { errorMessage } from '@/lib/errors'
import { matchOffsets, rowPosition, type DiffSearch } from './diff-search'
import { imageMediaType } from '@shared/git'
import type { DiffChanges, DiffHunk, DiffLine, FileChangeStatus, FileDiff } from '@shared/git'
import type { CommentThread } from '@shared/schemas'

/** Files longer than this arrive collapsed; see the note above. */
const COLLAPSE_ABOVE_LINES = 600

/** How many lines one nudge of an expander reveals. */
const EXPAND_STEP = 20

/**
 * Reveal ceiling for a run whose end is not known yet - the tail of a file
 * nobody has read. Matches the per-file line ceiling in `readReviewFile`, and
 * is clamped against the real length as soon as the text arrives.
 */
const EXPAND_UNBOUNDED = 20_000

const NO_THREADS: AnchoredThread[] = []

const STATUS_ICONS = {
  added: FilePlus,
  deleted: FileMinus,
  renamed: FileSymlink,
  copied: FileSymlink,
  modified: FileDiffIcon,
  changed: FileDiffIcon
}

const STATUS_COLOURS: Record<FileChangeStatus, string> = {
  added: 'text-success',
  deleted: 'text-destructive',
  renamed: 'text-muted-foreground',
  copied: 'text-muted-foreground',
  modified: 'text-muted-foreground',
  changed: 'text-muted-foreground'
}

/** The file card and the file tree label a change the same way. */
export function FileStatusIcon({
  status,
  className
}: {
  status: FileChangeStatus
  className?: string
}) {
  const Icon = STATUS_ICONS[status]
  return <Icon className={cn('size-4 shrink-0', STATUS_COLOURS[status], className)} />
}

/**
 * A run of lines on one side of the diff: what a comment covers, and what the
 * reviewer is dragging out before the composer opens. `startLine === line` is
 * an ordinary single-line comment, which is most of them.
 */
export interface LineRange {
  side: DiffSide
  startLine: number
  line: number
}

/** A thread together with where it lands in the diff being displayed. */
export interface AnchoredThread extends CommentThread {
  anchor: ResolvedAnchor
}

/** Everything the diff needs in order to carry a discussion. */
export interface DiffComments {
  reviewId: number
  /** Only the threads for the file being rendered. */
  threads: AnchoredThread[]
  mutations: CommentMutations
  /**
   * The view the line numbers on screen came from, sent with a new thread so
   * its anchor is captured from the diff the commenter was actually reading.
   */
  changes: DiffChanges
}

/**
 * What the card needs to read more of the file than the patch contains, and to
 * hand it to an editor.
 *
 * `changes` has to be the setting the diff on screen was read with: unfolded
 * context from another version of the file would not line up with the hunks it
 * sits between.
 */
export interface DiffFileSource {
  reviewId: number
  changes: DiffChanges
  /** Editor to open in, from `system.editors()`. Null uses the default. */
  editorId?: string | null
  /** Named in the button's tooltip, so the click holds no surprises. */
  editorLabel?: string | null
  onOpenInEditor?: (path: string, line: number) => void
}

/**
 * The reviewer's "I have read this" mark on one file.
 *
 * Whether the mark still holds is decided by the caller, which is the only
 * place that knows both what was stored and which diff is on screen - see
 * `shared/diff-digest.ts`. The card is told the answer, not asked to work it
 * out, so the checkbox and the file tree can never disagree.
 */
export interface ReviewedMark {
  /** True while the mark matches the diff being shown. */
  isReviewed: boolean
  /**
   * True when this file was ticked off against an older version of itself.
   * The tick is gone - it has to be - but saying so is more useful than
   * silently clearing it, because it points at the one file in the list that
   * was read and then changed under the reviewer.
   */
  hasChangedSince: boolean
  onChange: (reviewed: boolean) => void
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  )
}

/**
 * Whether the parts of this file the diff left out can be shown at all.
 *
 * A binary file has no lines; a clipped one is already more than the renderer
 * will take; a deleted one has no head-side text to read. A new or untracked
 * file is in the patch *in full*, so there is nothing hidden to ask for - and
 * offering to unfold nothing is worse than not offering.
 */
function isExpandable(file: FileDiff): boolean {
  if (file.isBinary || file.truncated || file.hunks.length === 0) return false
  if (file.status === 'deleted' || file.status === 'added') return false
  return !file.isUntracked
}

export function FileDiffCard({
  file,
  comments,
  source,
  focus,
  marked,
  reviewed,
  search
}: {
  file: FileDiff
  comments?: DiffComments
  source?: DiffFileSource
  /** A line in *this* file someone has navigated to; opens the card if folded. */
  focus?: { side: DiffSide; line: number }
  /** The same line while it is still worth pointing at. */
  marked?: { side: DiffSide; line: number }
  /** Omitted where there is nothing to mark against - a card shown on its own. */
  reviewed?: ReviewedMark
  /** The find running over the whole diff, as it applies to this file. */
  search?: DiffSearch
}) {
  const lineCount = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  /** Null until the reviewer opens or closes the card themselves. */
  const [toggled, setToggled] = useState<boolean | null>(null)
  /** The lines the reviewer is writing a new comment on. */
  const [composingOn, setComposingOn] = useState<LineRange | null>(null)
  /** The range being dragged out right now, before the pointer comes up. */
  const [dragging, setDragging] = useState<LineRange | null>(null)
  /** Head-side line numbers unfolded out of the gaps between the hunks. */
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set())

  const isReviewed = reviewed?.isReviewed ?? false

  /**
   * Derived rather than stored, so arriving at a line inside a folded file just
   * opens it - no effect, no second render, and a card the reviewer has closed
   * by hand stays closed.
   */
  const expanded =
    // A hit the reader is being walked to wins over a card they closed by hand,
    // or ticked off: "12 matches" that stops on a file showing nothing would be
    // a lie. It is only for as long as the hit is the current one - move on, and
    // the card goes back to however the reader left it.
    search?.active != null ||
    (toggled ??
      // A file already ticked off arrives folded: the list of what is left to
      // read is the point of the mark, and a read file taking up a screen of
      // space works against it.
      (focus !== undefined || (!isReviewed && lineCount <= COLLAPSE_ABOVE_LINES)))
  const setExpanded = setToggled

  /**
   * Fold the card when the file gets ticked off, unfold it when it stops being
   * ticked off.
   *
   * Driven by the mark changing rather than by the checkbox being clicked, so
   * the keyboard shortcut in the files tab does exactly what the checkbox does
   * - and so does the mark lapsing when a refresh brings in a new version of a
   * file that had been read. Folding on the way in is the reason the mark is
   * worth setting: the page shrinks to what is still unread. On the way out the
   * card is handed back its default behaviour rather than forced open, so a
   * file that would have arrived folded for its sheer size still does.
   */
  const wasReviewed = useRef(isReviewed)

  useEffect(() => {
    if (isReviewed === wasReviewed.current) return
    wasReviewed.current = isReviewed
    setToggled(isReviewed ? false : null)
  }, [isReviewed])

  const canExpand = source !== undefined && isExpandable(file)
  const text = useReviewFile(canExpand ? source.reviewId : null, file.path, source?.changes ?? 'all')

  const reveal = useCallback(
    (from: number, to: number) => {
      text.load()
      setRevealed((current) => {
        const next = new Set(current)
        for (let line = from; line <= to; line += 1) next.add(line)
        return next
      })
    },
    [text]
  )

  /**
   * Start commenting at a line, or grow the open range to reach it.
   *
   * Two gestures, both of which people already know from GitHub: press and
   * drag the `+` down the gutter, or shift-click a second line. Shift-click
   * keeps the first line of the existing range as the anchor, so the range
   * only ever grows away from where the reviewer started.
   */
  const startSelection = useCallback(
    (side: DiffSide, line: number, extend: boolean) => {
      if (extend && composingOn && composingOn.side === side) {
        const anchor = composingOn.startLine
        setComposingOn({ side, startLine: Math.min(anchor, line), line: Math.max(anchor, line) })
        return
      }
      setDragging({ side, startLine: line, line })
    },
    [composingOn]
  )

  const dragOver = useCallback((side: DiffSide, line: number) => {
    setDragging((current) => {
      if (!current || current.side !== side || current.line === line) return current
      // `startLine` stays the line the drag began on; the pointer can be either
      // side of it, and the range is normalised when the pointer comes up.
      return { ...current, line }
    })
  }, [])

  /**
   * A drag ends wherever the pointer is released, which is often outside the
   * button - or outside the card - so the listener goes on the window.
   *
   * The *move* is on the window for a different and less obvious reason. Rows
   * also report `onPointerEnter`, and with a mouse that is enough: the pointer
   * really does travel across each row and each row really is told. A finger
   * does not work that way. Touch sets *implicit pointer capture* on whatever
   * the gesture started on - the `+` button - so for the rest of the drag every
   * pointer event is delivered to that button and no row is ever entered. The
   * range simply never grew, which is why dragging out several lines worked on
   * a desktop and did nothing at all on a phone.
   *
   * So the pointer is followed rather than waited for: one listener, hit-test
   * where it actually is, read the row's own `data-diff-*` off the result. That
   * is correct for a mouse too - `onPointerEnter` stays because it costs
   * nothing and keeps the desktop path working if a hit-test ever lands on
   * something unexpected - and it is the same set of coordinates either way.
   */
  useEffect(() => {
    if (!dragging) return

    const move = (event: PointerEvent): void => {
      const under = document.elementFromPoint(event.clientX, event.clientY)
      const row = under?.closest('[data-diff-line]')
      if (!row) return
      const side = row.getAttribute('data-diff-side')
      const line = Number(row.getAttribute('data-diff-line'))
      if ((side === 'base' || side === 'head') && Number.isInteger(line)) dragOver(side, line)
    }

    const finish = (): void => {
      const startLine = Math.min(dragging.startLine, dragging.line)
      const line = Math.max(dragging.startLine, dragging.line)
      setDragging(null)
      setComposingOn((current) =>
        // Clicking the `+` of a composer that is already open on exactly those
        // lines closes it again, which is how the button worked before ranges.
        current && current.side === dragging.side && current.startLine === startLine && current.line === line
          ? null
          : { side: dragging.side, startLine, line }
      )
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [dragging, dragOver])

  // A shared constant rather than a fresh `[]`, so a file with no comments
  // does not hand the memo below a new array identity on every render.
  const threads = comments?.threads ?? NO_THREADS

  /**
   * Threads that can be shown next to a line, keyed by where they now sit -
   * which is the resolved anchor, not the stored line number.
   */
  const placed = useMemo(() => {
    const map = new Map<string, AnchoredThread[]>()
    for (const thread of threads) {
      if (thread.anchor.line === null || thread.side === null) continue
      const key = `${thread.side}:${thread.anchor.line}`
      const existing = map.get(key)
      if (existing) existing.push(thread)
      else map.set(key, [thread])
    }
    return map
  }, [threads])

  const gaps = useMemo(
    () => (canExpand ? fileGaps(file.hunks, { includeTail: true }) : []),
    [canExpand, file.hunks]
  )
  const gapByHunk = useMemo(() => new Map(gaps.map((gap) => [gap.beforeHunk, gap])), [gaps])
  const tailGap = gapByHunk.get(file.hunks.length)

  /**
   * Every line a thread's range covers, so the diff can show how far a comment
   * about a block reaches. The thread itself still renders under its last line.
   */
  const covered = useMemo(() => {
    const lines = new Set<string>()
    for (const thread of threads) {
      const { line, startLine } = thread.anchor
      if (line === null || startLine === null || thread.side === null) continue
      for (let current = startLine; current <= line; current += 1) {
        lines.add(`${thread.side}:${current}`)
      }
    }
    return lines
  }, [threads])

  const rowContext: RowContext = {
    placed,
    comments,
    composingOn,
    onCompose: setComposingOn,
    onSelectStart: startSelection,
    onSelectOver: dragOver,
    // While the pointer is down the drag wins; after it comes up the composer's
    // own range is what stays lit.
    selection: dragging
      ? {
          side: dragging.side,
          startLine: Math.min(dragging.startLine, dragging.line),
          line: Math.max(dragging.startLine, dragging.line)
        }
      : composingOn,
    covered,
    marked: marked ?? null,
    filePath: file.path,
    search: search ?? null
  }

  const orphans = threads.filter((thread) => thread.anchor.line === null)
  const unresolvedCount = threads.filter((thread) => thread.resolvedAt === null).length

  const hasBody = file.hunks.length > 0
  /**
   * A binary file git cannot diff, but a person can still see. The card then
   * has something worth opening even though it has no lines - which is why the
   * fold below asks `canToggle` rather than `hasBody`.
   */
  const showsImage = source !== undefined && file.isBinary && imageMediaType(file.path) !== null
  const canToggle = hasBody || showsImage
  const totalLines = text.content && !text.content.isBinary ? text.content.lines.length : null

  const expandControls: ExpandControls = {
    reveal,
    loading: text.requested && text.isLoading,
    error: text.content?.error ?? (text.error === undefined ? null : errorMessage(text.error))
  }

  function expandEverything(): void {
    for (const gap of gaps) reveal(gap.start, gap.end ?? gap.start + EXPAND_UNBOUNDED)
    setExpanded(true)
  }

  /**
   * The sections of the body, in the order they are drawn.
   *
   * Named rather than asked inline, because the rules between them are now the
   * header's to draw. The header is sticky, so a line belonging to the *top* of
   * the first section scrolls up underneath it and leaves the file name sitting
   * straight on the code; the header carries its own bottom rule instead, and
   * each section below asks only whether something precedes it.
   */
  const showsOrphans = expanded && orphans.length > 0 && comments !== undefined
  const showsDiff = expanded && hasBody
  const showsImageDiff = expanded && showsImage && source !== undefined
  const showsBinaryNote = expanded && !hasBody && file.isBinary && !showsImage
  const showsBody = showsOrphans || showsDiff || showsImageDiff || showsBinaryNote

  return (
    // `clip` rather than `hidden`: both cut the diff to the card's rounded
    // corners, but `hidden` makes the card a scroll container of its own, and a
    // scroll container that cannot scroll is a scrollport the sticky header
    // below would be pinned inside - never moving, never sticking.
    <Card className="overflow-clip">
      {/* Not one big button any more: the header carries actions of its own,
          and a button inside a button is not a thing the DOM allows. */}
      {/* Wraps, and the path keeps a floor of a few inches: on a narrow window
          the badges drop to a line of their own rather than squeezing the path
          into a column one character wide. */}
      <div
        className={cn(
          // Sticky, so a file taller than the window never leaves the reader
          // wondering which file they are in: the path, the stat, the reviewed
          // checkbox and the actions stay in reach the whole way down it. It
          // sticks *inside its own card*, so it gives way to the next file's
          // header rather than outliving the diff it names.
          //
          // `--diff-sticky-top` is whatever the tab has parked above it - the
          // find bar, when that is open. On its own the header rests against
          // the top of the scroller.
          'sticky top-[var(--diff-sticky-top,0px)] z-10 flex w-full flex-wrap items-center gap-1 bg-card pr-2',
          showsBody && 'border-b border-border'
        )}
      >
        <div className="flex min-w-0 grow basis-64 items-center gap-1">
          {/* The toggle takes only the room the path needs rather than the whole
              row, so the copy button can sit against the end of the path and
              read as belonging to it. */}
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            disabled={!canToggle}
            aria-expanded={expanded}
            className={cn(
              'flex min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors',
              canToggle ? 'hover:bg-muted/50' : 'cursor-default'
            )}
          >
            {canToggle ? (
              expanded ? (
                <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="size-4 shrink-0" />
            )}

            <FileStatusIcon status={file.status} />

            <span data-selectable className="min-w-0 font-mono text-xs">
              {file.oldPath && file.oldPath !== file.path && (
                <span className="text-muted-foreground">
                  <FilePath path={file.oldPath} emphasizeName={false} /> →{' '}
                </span>
              )}
              <FilePath path={file.path} />
            </span>
          </button>

          <CopyPathAction path={file.path} />
        </div>

        {/* Everything else keeps to the far end of the row, and where there is
            room it never shrinks: when the path is long it is the path that
            wraps, not the badges.

            Below `lg` there is no such room - the badges, the reviewed
            checkbox and the actions come to more than a phone is wide - so
            they wrap among themselves instead of running off the end of the
            card, where nothing could scroll them back into reach. */}
        <div className="ml-auto flex flex-wrap items-center gap-2 py-1 pl-2 lg:flex-nowrap lg:shrink-0">
          {/* Shown even while the file is folded shut, so a discussion is never
            hidden by a collapse the reviewer did not think about. */}
          {threads.length > 0 && (
            <Badge
              variant={unresolvedCount > 0 ? 'default' : 'outline'}
              title={
                unresolvedCount > 0
                  ? `${unresolvedCount} unresolved of ${threads.length}`
                  : 'All comments on this file are resolved'
              }
            >
              <MessageSquare />
              {unresolvedCount > 0 ? unresolvedCount : threads.length}
            </Badge>
          )}

          {file.isUntracked && (
            <Badge variant="warning" title="This file is not tracked by git yet">
              <CircleDot />
              untracked
            </Badge>
          )}
          {!file.isUntracked && file.hasUncommittedChanges && (
            <Badge variant="warning" title="Part of this change is not committed">
              <CircleDot />
              uncommitted
            </Badge>
          )}
          {file.isBinary && <Badge variant="outline">binary</Badge>}
          {file.truncated && <Badge variant="outline">clipped</Badge>}

          {!file.isBinary && <DiffStat additions={file.additions} deletions={file.deletions} />}

          {/* Sits between the file's facts and the actions on it, because it is
              neither: it is what the reviewer has done about this file. */}
          {reviewed && (
            <label
              className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              title={
                reviewed.hasChangedSince
                  ? 'You marked this file reviewed, and it has changed since. Read it again to mark it.'
                  : reviewed.isReviewed
                    ? 'Marked as reviewed. The mark clears itself if the file changes.'
                    : 'Mark this file as reviewed. The mark clears itself if the file changes.'
              }
            >
              <Checkbox checked={isReviewed} onCheckedChange={reviewed.onChange} />
              {reviewed.hasChangedSince ? (
                <span className="text-warning">Changed since reviewed</span>
              ) : (
                'Reviewed'
              )}
            </label>
          )}

          <FileActions
            file={file}
            source={source}
            canExpand={gaps.length > 0}
            onExpandAll={expandEverything}
          />
        </div>
      </div>

      {showsOrphans && comments && (
        <div className="flex flex-col gap-3 bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            {orphans.length === 1 ? 'This comment is' : 'These comments are'} on code that is not in
            the diff any more.
          </p>
          {/* The snapshot taken when the comment was written is all that is
              left of the code it was about, so it is printed rather than a bare
              "was line 12" - a discussion nobody can follow is barely better
              than a lost one. */}
          {orphans.map((thread) => {
            const snippet = threadSnippet(thread, thread.anchor, file)
            const hasSnippet = snippet !== null && snippet.lines.length > 0

            return (
              <div key={thread.id} className="flex flex-col gap-2">
                {hasSnippet && <DiffSnippet {...snippet} />}
                <CommentThreadCard
                  thread={thread}
                  mutations={comments.mutations}
                  anchorState={thread.anchor.state}
                  // The snippet header already names the line it was on; this
                  // is only for a thread too old to have a snapshot.
                  location={
                    !hasSnippet && thread.line !== null ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        was line {thread.line}
                      </span>
                    ) : null
                  }
                />
              </div>
            )
          })}
        </div>
      )}

      {showsDiff && (
        <div className={cn(showsOrphans && 'border-t border-border')}>
          {/* `@container` makes this element an inline-size container, which is
              what lets a comment inside it be sized to the *visible* width
              rather than to the width of the scrolled code. */}
          <div className={cn('@container overflow-x-auto', dragging && 'select-none')}>
            <div className="min-w-max font-mono text-xs leading-5">
              {file.hunks.map((hunk, index) => {
                const gap = gapByHunk.get(index)
                const segments = gap ? segmentGap(gap, revealed, totalLines) : []

                /**
                 * A `@@` header announces a break in the file, so it is printed
                 * only when there is still a break to announce.
                 *
                 * Three ways there is nothing to announce. The hunk carries
                 * straight on from what is above it - the previous hunk, or the
                 * start of the file, which covers every new and deleted file.
                 * Or there is a gap and it is still folded, in which case its
                 * last expander carries the header itself, the way GitHub puts
                 * the unfold controls on that row. Or that gap has been
                 * unfolded, and the code now runs continuously into the hunk.
                 *
                 * What is left - a real break with no expander to mark it -
                 * happens in files the diff cannot unfold at all, and there the
                 * header is the only thing saying the lines are not adjacent.
                 */
                const showHeader = gap === undefined && !continuesFromAbove(file.hunks, index)

                return (
                  <Fragment key={`${hunk.header}-${index}`}>
                    {gap && (
                      <GapRows
                        gap={gap}
                        segments={segments}
                        lines={text.content?.lines ?? null}
                        controls={expandControls}
                        header={hunk.header}
                        rows={rowContext}
                      />
                    )}
                    <HunkRows hunk={hunk} showHeader={showHeader} {...rowContext} />
                  </Fragment>
                )
              })}

              {tailGap && (
                <GapRows
                  gap={tailGap}
                  segments={segmentGap(tailGap, revealed, totalLines)}
                  lines={text.content?.lines ?? null}
                  controls={expandControls}
                  header={null}
                  rows={rowContext}
                />
              )}
            </div>
          </div>
          {file.truncated && (
            <p className="border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              This file is too large to show in full. Open it in your editor to read the rest.
            </p>
          )}
        </div>
      )}

      {showsImageDiff && source && (
        <div className={cn((showsOrphans || showsDiff) && 'border-t border-border')}>
          <ImageDiff file={file} reviewId={source.reviewId} changes={source.changes} />
        </div>
      )}

      {showsBinaryNote && (
        <p
          className={cn(
            'px-3 py-3 text-xs text-muted-foreground',
            showsOrphans && 'border-t border-border'
          )}
        >
          Binary file — no text diff to show.
        </p>
      )}
    </Card>
  )
}

/**
 * Copy the path to the clipboard.
 *
 * It sits against the end of the path rather than in the row of actions on the
 * far side of the header, because "copy" on its own says nothing about what
 * gets copied - next to the thing it copies, it needs no explaining.
 */
function CopyPathAction({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  async function copyPath(): Promise<void> {
    await navigator.clipboard.writeText(path)
    setCopied(true)
    // Long enough to be read, short enough that the button is itself again
    // before the reviewer next looks at it.
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <IconAction
      label={copied ? 'Path copied' : 'Copy path'}
      onClick={() => void copyPath()}
      icon={copied ? <Check className="text-success" /> : <Copy />}
    />
  )
}

/** Open the file, unfold the whole thing. */
function FileActions({
  file,
  source,
  canExpand,
  onExpandAll
}: {
  file: FileDiff
  source: DiffFileSource | undefined
  canExpand: boolean
  onExpandAll: () => void
}) {
  const canOpen = source?.onOpenInEditor !== undefined && file.status !== 'deleted'

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {canExpand && (
        <IconAction
          label="Expand all lines in this file"
          onClick={onExpandAll}
          icon={<UnfoldVertical />}
        />
      )}
      {canOpen && (
        <IconAction
          label={
            source?.editorLabel ? `Open in ${source.editorLabel}` : 'Open in your editor'
          }
          onClick={() => source?.onOpenInEditor?.(file.path, 1)}
          icon={<SquareArrowOutUpRight />}
        />
      )}
    </div>
  )
}

function IconAction({
  label,
  onClick,
  icon
}: {
  label: string
  onClick: () => void
  icon: ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground',
          '[&_svg]:size-3.5 [&_svg]:shrink-0'
        )}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/** What an expander needs to be able to do. */
interface ExpandControls {
  reveal: (from: number, to: number) => void
  loading: boolean
  error: string | null
}

/**
 * One gap between two hunks: expanders for what is still folded, ordinary
 * context rows for what has been unfolded.
 *
 * Unfolded lines are rendered through `LineRow` like any other, so they carry
 * the same comment affordance - a remark about the function a change sits
 * inside is exactly the remark that needs a line the patch did not print.
 */
function GapRows({
  gap,
  segments,
  lines,
  controls,
  header,
  rows
}: {
  gap: DiffGap
  segments: GapSegment[]
  lines: string[] | null
  controls: ExpandControls
  /** The following hunk's `@@` header, absorbed into the last expander. */
  header: string | null
  rows: RowContext
}) {
  // Nothing is known about the tail until the file has been read, so it gets a
  // single open-ended expander rather than a measured one.
  if (segments.length === 0) {
    return (
      <ExpanderBand
        start={gap.start}
        end={null}
        hasAbove
        hasBelow={false}
        header={header}
        controls={controls}
      />
    )
  }

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'hidden') {
          return (
            <ExpanderBand
              key={`hidden-${segment.start}`}
              start={segment.start}
              end={segment.end}
              // Something to read above means "unfold downwards from the top"
              // is the useful direction, and vice versa.
              hasAbove={index > 0 || gap.beforeHunk > 0}
              hasBelow={index < segments.length - 1 || gap.end !== null}
              header={index === segments.length - 1 ? header : null}
              controls={controls}
            />
          )
        }

        const revealedLines: DiffLine[] = []
        for (let line = segment.start; line <= segment.end; line += 1) {
          const content = lines?.[line - 1]
          if (content === undefined) continue
          revealedLines.push({
            type: 'context',
            content,
            oldNumber: line - gap.delta,
            newNumber: line
          })
        }

        return (
          <Fragment key={`context-${segment.start}`}>
            {revealedLines.map((line) => (
              <LineRow key={`context-${line.newNumber}`} line={line} {...rows} />
            ))}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * The band that stands in for folded lines.
 *
 * Styled as the `@@` header row it replaces, with the unfold controls in the
 * gutter - the same place GitHub puts them, which is the place a reviewer's
 * eye already is when they want more context.
 */
function ExpanderBand({
  start,
  end,
  hasAbove,
  hasBelow,
  header,
  controls
}: {
  start: number
  /** Null when the file has not been read and its end is unknown. */
  end: number | null
  hasAbove: boolean
  hasBelow: boolean
  header: string | null
  controls: ExpandControls
}) {
  const hidden = end === null ? null : end - start + 1
  // A run of unknown length is stepped too: the tail of a file nobody has read
  // yet is the one place where "show me a bit more" matters most.
  const stepped = hidden === null || hidden > EXPAND_STEP

  return (
    <div className="grid grid-cols-[3rem_3rem_1fr] bg-muted/60 text-muted-foreground">
      <div className="col-span-2 flex items-center justify-center gap-0.5 border-r border-border">
        {/* Down unfolds from the top of the run, next to the code above it; up
            unfolds from the bottom, next to the code below. */}
        {hasAbove && stepped && (
          <ExpandButton
            label={`Show ${EXPAND_STEP} more lines`}
            disabled={controls.loading}
            onClick={() => controls.reveal(start, start + EXPAND_STEP - 1)}
            icon={<ChevronsDown />}
          />
        )}
        {hasBelow && stepped && end !== null && (
          <ExpandButton
            label={`Show ${EXPAND_STEP} more lines`}
            disabled={controls.loading}
            onClick={() => controls.reveal(end - EXPAND_STEP + 1, end)}
            icon={<ChevronsUp />}
          />
        )}
        <ExpandButton
          label={hidden === null ? 'Show the rest of the file' : `Show all ${hidden} hidden lines`}
          disabled={controls.loading}
          onClick={() => controls.reveal(start, end ?? start + EXPAND_UNBOUNDED)}
          icon={<UnfoldVertical />}
        />
      </div>
      <span className="flex items-center gap-3 whitespace-pre px-3 py-0.5">
        {header}
        {controls.error !== null ? (
          <span className="font-sans text-[0.6875rem] text-destructive">{controls.error}</span>
        ) : (
          <span className="font-sans text-[0.6875rem] opacity-70">
            {controls.loading
              ? 'reading the file…'
              : hidden === null
                ? 'more of this file'
                : `${hidden} hidden ${hidden === 1 ? 'line' : 'lines'}`}
          </span>
        )}
      </span>
    </div>
  )
}

function ExpandButton({
  label,
  onClick,
  icon,
  disabled
}: {
  label: string
  onClick: () => void
  icon: ReactNode
  disabled: boolean
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'flex size-5 items-center justify-center rounded transition-colors',
          'hover:bg-primary hover:text-primary-foreground disabled:opacity-50',
          '[&_svg]:size-3 [&_svg]:shrink-0'
        )}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

interface RowContext {
  placed: Map<string, AnchoredThread[]>
  comments: DiffComments | undefined
  /** The range the composer is open on, if any. */
  composingOn: LineRange | null
  onCompose: (target: LineRange | null) => void
  /** Begin a selection at this line, or extend the open one when held. */
  onSelectStart: (side: DiffSide, line: number, extend: boolean) => void
  /** Drag the selection over this line. Ignored when nothing is being dragged. */
  onSelectOver: (side: DiffSide, line: number) => void
  /** Lines the reviewer is currently selecting or composing on. */
  selection: LineRange | null
  /** Lines already covered by an existing thread's range. */
  covered: ReadonlySet<string>
  /** The line arrived at from a conversation thread, marked briefly. */
  marked: { side: DiffSide; line: number } | null
  filePath: string
  /** The find in progress, so a row can pick its own hits out. */
  search: DiffSearch | null
}

function HunkRows({
  hunk,
  showHeader,
  ...context
}: { hunk: DiffHunk; showHeader: boolean } & RowContext) {
  return (
    <>
      {showHeader && (
        <div className="grid grid-cols-[3rem_3rem_1fr] bg-muted/60 text-muted-foreground">
          <span className="col-span-2 border-r border-border" />
          <span className="whitespace-pre px-3 py-0.5">{hunk.header}</span>
        </div>
      )}
      {hunk.lines.map((line, index) => (
        <LineRow key={index} line={line} {...context} />
      ))}
    </>
  )
}

function LineRow({
  line,
  placed,
  comments,
  composingOn,
  onCompose,
  onSelectStart,
  onSelectOver,
  selection,
  covered,
  marked,
  filePath,
  search
}: { line: DiffLine } & RowContext) {
  // Which side a comment on this row belongs to, and the number it carries
  // there. Shared with the search, so a hit is addressed to the row it is on.
  const { side, number } = rowPosition(line)

  const threads = number === null ? [] : (placed.get(`${side}:${number}`) ?? [])
  // The composer opens under the *last* line of the range, where the eye is
  // after dragging down it.
  const composing = number !== null && composingOn?.side === side && composingOn.line === number
  const selected =
    number !== null &&
    selection?.side === side &&
    number >= selection.startLine &&
    number <= selection.line
  const isMarked = number !== null && marked?.side === side && marked.line === number
  const inThread = number !== null && covered.has(`${side}:${number}`)

  const rangeLabel =
    composingOn && composingOn.startLine < composingOn.line
      ? `lines ${composingOn.startLine}–${composingOn.line}`
      : `line ${number ?? ''}`

  return (
    <>
      <div
        id={number === null ? undefined : lineDomId(filePath, side, number)}
        // Read by the drag listener in `DiffFileCard`, which hit-tests the
        // pointer rather than waiting to be entered - see the note there. On
        // the row rather than on the gutter cell because a finger dragging down
        // the left edge wanders across all three columns.
        data-diff-side={number === null ? undefined : side}
        data-diff-line={number === null ? undefined : number}
        className={cn(
          'group grid grid-cols-[3rem_3rem_1fr]',
          // Backgrounds are mutually exclusive rather than layered: two
          // background utilities on one element are resolved by stylesheet
          // order, not by the order they are written here.
          isMarked
            ? 'bg-warning/25'
            : selected
              ? 'bg-primary/15'
              : line.type === 'insert'
                ? 'bg-success/10'
                : line.type === 'delete'
                  ? 'bg-destructive/10'
                  : undefined,
          // A box-shadow instead, so the marker for "a comment covers this
          // line" can sit on top of whichever background won above.
          inThread && 'shadow-[inset_3px_0_0_0_var(--color-primary)]'
        )}
      >
        <Gutter value={line.oldNumber} />
        <div
          className="relative border-r border-border"
          // Extending a drag has to be caught on the row, not on the button:
          // the pointer is held down, so it never enters another button.
          onPointerEnter={() => {
            if (number !== null) onSelectOver(side, number)
          }}
        >
          <span className="block select-none px-2 text-right tabular-nums text-muted-foreground/70">
            {line.newNumber ?? ''}
          </span>
          {/* Only appears on hover, so it never competes with the code for
              attention, and only when there is somewhere to put the comment. */}
          {comments && number !== null && (
            <button
              type="button"
              onPointerDown={(event) => {
                // Stops the browser starting a text selection, which would
                // otherwise highlight the code as the pointer is dragged.
                event.preventDefault()
                onSelectStart(side, number, event.shiftKey)
              }}
              onClick={(event) => {
                // `detail === 0` is a click from the keyboard, which never
                // produced a pointerdown; the pointer path is handled above.
                if (event.detail === 0) onSelectStart(side, number, event.shiftKey)
              }}
              title={`Comment on ${side === 'head' ? 'line' : 'removed line'} ${number} — drag or shift-click for several`}
              aria-label={`Comment on line ${number} of ${filePath}`}
              className={cn(
                'absolute left-0.5 top-1/2 flex -translate-y-1/2 items-center justify-center rounded bg-primary p-0.5 text-primary-foreground shadow-sm',
                // `touch-none` is what lets a finger drag the range out at all:
                // whether a touch scrolls the page or becomes a pointer drag is
                // decided by `touch-action` and by nothing else -
                // `preventDefault` on pointerdown does not reach that decision.
                'touch-none',
                'focus-visible:flex',
                // Visible by default, and hidden again only where hovering is a
                // thing that can happen.
                //
                // It used to be the other way round - `hidden`, revealed by
                // `group-hover` - which on a phone is a button that does not
                // exist, because there is no hover to wait for and no other way
                // in. Commenting on a line was unreachable rather than merely
                // awkward. `(hover: hover)` is the only honest test for that: it
                // asks about the pointer the person actually has, rather than
                // about a screen width or a user agent string, so a tablet with
                // a mouse gets the desktop behaviour and a touchscreen laptop
                // gets both.
                //
                // Written as one either/or rather than as a pile of classes
                // that override each other. A hidden and a shown variant of the
                // same media query are the same specificity inside it, so which
                // one won would come down to the order Tailwind happened to
                // emit them in; only one of them is ever in the string.
                //
                // (The other reason not to write the losing class in a comment
                // here: Tailwind scans this file for candidates and does not
                // know a comment from code, so naming one would compile a dead
                // rule into the stylesheet.)
                composing || selected
                  ? null
                  : [
                      '[@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:flex',
                      // Standing at every line where it cannot hide, it has to
                      // stop being the loudest thing in the gutter. It sits left
                      // of the right-aligned line number rather than over it, so
                      // this is weight rather than occlusion - and it is back to
                      // full strength on the range it is actually holding.
                      '[@media(hover:none)]:opacity-70'
                    ]
              )}
            >
              <Plus className="size-3" />
            </button>
          )}
        </div>
        <span
          data-selectable
          onPointerEnter={() => {
            if (number !== null) onSelectOver(side, number)
          }}
          className={cn(
            'whitespace-pre px-3',
            line.type === 'insert' && 'text-success',
            line.type === 'delete' && 'text-destructive'
          )}
        >
          <span aria-hidden className="select-none opacity-60">
            {line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' '}
          </span>
          <LineText
            content={line.content}
            query={search?.query ?? null}
            activeOccurrence={
              number !== null &&
              search?.active != null &&
              search.active.side === side &&
              search.active.line === number
                ? search.active.occurrence
                : null
            }
          />
        </span>
      </div>

      {(threads.length > 0 || composing) && comments && (
        // Breaks out of the monospace diff grid: a discussion is prose, and
        // reading it in a 12px mono column inside a horizontally scrolling
        // container is miserable. The width is the *visible* width of that
        // container (`cqi`), not the width of its scrolled contents, so the
        // discussion stays inside the file card however long the lines are.
        <div className="sticky left-0 flex w-[min(48rem,100cqi)] flex-col gap-2 border-y border-border bg-muted/20 p-3 font-sans text-sm">
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
                ) : null
              }
            />
          ))}

          {composing && number !== null && composingOn && (
            <div className="rounded-lg border border-border bg-card p-3">
              <CommentComposer
                autoFocus
                placeholder={`Comment on ${rangeLabel}`}
                onCancel={() => onCompose(null)}
                onSubmit={async (body) => {
                  await comments.mutations.createThread({
                    reviewId: comments.reviewId,
                    body,
                    filePath,
                    side,
                    line: number,
                    changes: comments.changes,
                    ...(composingOn.startLine < number
                      ? { startLine: composingOn.startLine }
                      : {})
                  })
                  onCompose(null)
                }}
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * One row's code, with the search hits picked out of it.
 *
 * The scan happens here, per rendered row, rather than being handed down from
 * the search: only the rows actually on screen pay for it, and a file the
 * reader never opened costs nothing. `matchOffsets` is the same function the
 * counter walks, so what is marked and what is counted cannot drift.
 */
function LineText({
  content,
  query,
  activeOccurrence
}: {
  content: string
  query: string | null
  /** Index of the hit *in this row* that the reader is being pointed at. */
  activeOccurrence: number | null
}) {
  const offsets = query === null ? [] : matchOffsets(content, query)
  if (query === null || offsets.length === 0) return <>{content}</>

  const parts: ReactNode[] = []
  let cursor = 0

  for (const [index, offset] of offsets.entries()) {
    if (offset > cursor) parts.push(content.slice(cursor, offset))
    const end = offset + query.length
    const isActive = index === activeOccurrence
    parts.push(
      <mark
        key={offset}
        id={isActive ? ACTIVE_MATCH_ID : undefined}
        className={cn(
          'rounded-[2px] text-inherit',
          // The current hit is the one the page just scrolled to, so it has to
          // be findable at a glance among the others on the same screen.
          isActive ? 'bg-warning/60 shadow-[0_0_0_1px_var(--color-warning)]' : 'bg-warning/25'
        )}
      >
        {content.slice(offset, end)}
      </mark>
    )
    cursor = end
  }

  if (cursor < content.length) parts.push(content.slice(cursor))
  return <>{parts}</>
}

function Gutter({ value }: { value: number | null }) {
  return (
    <span className="select-none border-r border-border px-2 text-right tabular-nums text-muted-foreground/70">
      {value ?? ''}
    </span>
  )
}
