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
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { DiffSnippet } from './diff-snippet'
import { lineDomId } from './dom-ids'
import { useReviewFile } from './use-reviews'
import type { CommentMutations } from '../comments/use-comments'
import { threadSnippet } from '@shared/comment-snippets'
import type { DiffSide, ResolvedAnchor } from '@shared/comment-anchors'
import { fileGaps, segmentGap, type DiffGap, type GapSegment } from '@shared/diff-gaps'
import { errorMessage } from '@/lib/errors'
import type { DiffHunk, DiffLine, FileChangeStatus, FileDiff } from '@shared/git'
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
}

/**
 * What the card needs to read more of the file than the patch contains, and to
 * hand it to an editor.
 *
 * `includeUncommitted` has to be the setting the diff on screen was read with:
 * unfolded context from the other version of the file would not line up with
 * the hunks it sits between.
 */
export interface DiffFileSource {
  reviewId: number
  includeUncommitted: boolean
  /** Editor to open in, from `system.editors()`. Null uses the default. */
  editorId?: string | null
  /** Named in the button's tooltip, so the click holds no surprises. */
  editorLabel?: string | null
  onOpenInEditor?: (path: string, line: number) => void
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
  marked
}: {
  file: FileDiff
  comments?: DiffComments
  source?: DiffFileSource
  /** A line in *this* file someone has navigated to; opens the card if folded. */
  focus?: { side: DiffSide; line: number }
  /** The same line while it is still worth pointing at. */
  marked?: { side: DiffSide; line: number }
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

  /**
   * Derived rather than stored, so arriving at a line inside a folded file just
   * opens it - no effect, no second render, and a card the reviewer has closed
   * by hand stays closed.
   */
  const expanded = toggled ?? (focus !== undefined || lineCount <= COLLAPSE_ABOVE_LINES)
  const setExpanded = setToggled

  const canExpand = source !== undefined && isExpandable(file)
  const text = useReviewFile(
    canExpand ? source.reviewId : null,
    file.path,
    source?.includeUncommitted ?? true
  )

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
   */
  useEffect(() => {
    if (!dragging) return

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

    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [dragging])

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
    filePath: file.path
  }

  const orphans = threads.filter((thread) => thread.anchor.line === null)
  const unresolvedCount = threads.filter((thread) => thread.resolvedAt === null).length

  const hasBody = file.hunks.length > 0
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

  return (
    <Card className="overflow-hidden">
      {/* Not one big button any more: the header carries actions of its own,
          and a button inside a button is not a thing the DOM allows. */}
      <div className="flex w-full items-center gap-2 pr-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          disabled={!hasBody}
          aria-expanded={expanded}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left transition-colors',
            hasBody ? 'hover:bg-muted/50' : 'cursor-default'
          )}
        >
          {hasBody ? (
            expanded ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="size-4 shrink-0" />
          )}

          <FileStatusIcon status={file.status} />

          <span
            data-selectable
            className="min-w-0 flex-1 truncate font-mono text-xs"
            title={file.path}
          >
            {file.oldPath && file.oldPath !== file.path && (
              <span className="text-muted-foreground">{file.oldPath} → </span>
            )}
            {file.path}
          </span>
        </button>

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

        <FileActions
          file={file}
          source={source}
          canExpand={gaps.length > 0}
          onExpandAll={expandEverything}
        />
      </div>

      {expanded && orphans.length > 0 && comments && (
        <div className="flex flex-col gap-3 border-t border-border bg-muted/20 p-3">
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

      {expanded && hasBody && (
        <div className="border-t border-border">
          {/* `@container` makes this element an inline-size container, which is
              what lets a comment inside it be sized to the *visible* width
              rather than to the width of the scrolled code. */}
          <div className={cn('@container overflow-x-auto', dragging && 'select-none')}>
            <div className="min-w-max font-mono text-xs leading-5">
              {file.hunks.map((hunk, index) => {
                const gap = gapByHunk.get(index)
                const segments = gap ? segmentGap(gap, revealed, totalLines) : []
                // The last expander of a gap carries the `@@` header of the
                // hunk below it, the way GitHub puts the unfold controls on
                // that row - so the hunk must not print it a second time.
                const absorbed = segments[segments.length - 1]?.kind === 'hidden'

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
                    <HunkRows hunk={hunk} showHeader={!absorbed} {...rowContext} />
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

      {expanded && !hasBody && file.isBinary && (
        <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
          Binary file — no text diff to show.
        </p>
      )}
    </Card>
  )
}

/** Copy the path, open the file, unfold the whole thing. */
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
  const [copied, setCopied] = useState(false)

  async function copyPath(): Promise<void> {
    await navigator.clipboard.writeText(file.path)
    setCopied(true)
    // Long enough to be read, short enough that the button is itself again
    // before the reviewer next looks at it.
    window.setTimeout(() => setCopied(false), 1500)
  }

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
      <IconAction
        label={copied ? 'Path copied' : 'Copy path'}
        onClick={() => void copyPath()}
        icon={copied ? <Check className="text-success" /> : <Copy />}
      />
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
  filePath
}: { line: DiffLine } & RowContext) {
  /**
   * Which side a comment on this row belongs to. Head where the line still
   * exists, base for a line the change deleted - the same choice GitHub makes,
   * and the only one that lets a reviewer remark on removed code at all.
   */
  const side: DiffSide = line.newNumber !== null ? 'head' : 'base'
  const number = side === 'head' ? line.newNumber : line.oldNumber

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
                'absolute left-0.5 top-1/2 hidden -translate-y-1/2 items-center justify-center rounded bg-primary p-0.5 text-primary-foreground shadow-sm',
                'group-hover:flex focus-visible:flex',
                (composing || selected) && 'flex'
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
          {line.content}
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

function Gutter({ value }: { value: number | null }) {
  return (
    <span className="select-none border-r border-border px-2 text-right tabular-nums text-muted-foreground/70">
      {value ?? ''}
    </span>
  )
}
