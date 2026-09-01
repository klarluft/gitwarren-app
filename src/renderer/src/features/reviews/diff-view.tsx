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
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
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
import { cn } from '@/lib/utils'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { DiffSnippet } from './diff-snippet'
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
  source
}: {
  file: FileDiff
  comments?: DiffComments
  source?: DiffFileSource
}) {
  const lineCount = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  const [expanded, setExpanded] = useState(lineCount <= COLLAPSE_ABOVE_LINES)
  /** Which line the reviewer is currently writing a new comment on. */
  const [composingOn, setComposingOn] = useState<{ side: DiffSide; line: number } | null>(null)
  /** Head-side line numbers unfolded out of the gaps between the hunks. */
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set())

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

  const rowContext: RowContext = {
    placed,
    comments,
    composingOn,
    onCompose: setComposingOn,
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
          onClick={() => setExpanded((current) => !current)}
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
          <div className="overflow-x-auto">
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
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
        'hover:bg-muted hover:text-foreground',
        '[&_svg]:size-3.5 [&_svg]:shrink-0'
      )}
    >
      {icon}
    </button>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'flex size-5 items-center justify-center rounded transition-colors',
        'hover:bg-primary hover:text-primary-foreground disabled:opacity-50',
        '[&_svg]:size-3 [&_svg]:shrink-0'
      )}
    >
      {icon}
    </button>
  )
}

interface RowContext {
  placed: Map<string, AnchoredThread[]>
  comments: DiffComments | undefined
  composingOn: { side: DiffSide; line: number } | null
  onCompose: (target: { side: DiffSide; line: number } | null) => void
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
  const composing =
    number !== null && composingOn?.side === side && composingOn.line === number

  return (
    <>
      <div
        className={cn(
          'group grid grid-cols-[3rem_3rem_1fr]',
          line.type === 'insert' && 'bg-success/10',
          line.type === 'delete' && 'bg-destructive/10'
        )}
      >
        <Gutter value={line.oldNumber} />
        <div className="relative border-r border-border">
          <span className="block select-none px-2 text-right tabular-nums text-muted-foreground/70">
            {line.newNumber ?? ''}
          </span>
          {/* Only appears on hover, so it never competes with the code for
              attention, and only when there is somewhere to put the comment. */}
          {comments && number !== null && (
            <button
              type="button"
              onClick={() => onCompose(composing ? null : { side, line: number })}
              title={`Comment on ${side === 'head' ? 'line' : 'removed line'} ${number}`}
              aria-label={`Comment on line ${number} of ${filePath}`}
              className={cn(
                'absolute left-0.5 top-1/2 hidden -translate-y-1/2 items-center justify-center rounded bg-primary p-0.5 text-primary-foreground shadow-sm',
                'group-hover:flex focus-visible:flex',
                composing && 'flex'
              )}
            >
              <Plus className="size-3" />
            </button>
          )}
        </div>
        <span
          data-selectable
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
        // container is miserable.
        <div className="sticky left-0 flex w-full max-w-3xl flex-col gap-2 border-y border-border bg-muted/20 p-3 font-sans text-sm">
          {threads.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              mutations={comments.mutations}
              anchorState={thread.anchor.state}
            />
          ))}

          {composing && number !== null && (
            <div className="rounded-lg border border-border bg-card p-3">
              <CommentComposer
                autoFocus
                placeholder={`Comment on line ${number}`}
                onCancel={() => onCompose(null)}
                onSubmit={async (body) => {
                  await comments.mutations.createThread({
                    reviewId: comments.reviewId,
                    body,
                    filePath,
                    side,
                    line: number
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
