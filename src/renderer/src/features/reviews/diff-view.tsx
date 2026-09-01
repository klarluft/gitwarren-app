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
 * Comments are threaded in against the diff *currently on screen*, using the
 * anchors resolved by `shared/comment-anchors`. A thread whose line has moved
 * follows the code; one whose line is gone is listed above the file rather than
 * dropped, because a comment the reader cannot find is worse than a comment
 * shown slightly out of place. A file with a collapsed body still shows its
 * comment count, so a discussion is never hidden behind a fold.
 */
import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileDiff as FileDiffIcon,
  FileMinus,
  FilePlus,
  FileSymlink,
  MessageSquare,
  Plus
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { CommentComposer } from '../comments/comment-composer'
import { CommentThreadCard } from '../comments/comment-thread-card'
import type { CommentMutations } from '../comments/use-comments'
import type { DiffSide, ResolvedAnchor } from '@shared/comment-anchors'
import type { DiffHunk, DiffLine, FileDiff } from '@shared/git'
import type { CommentThread } from '@shared/schemas'

/** Files longer than this arrive collapsed; see the note above. */
const COLLAPSE_ABOVE_LINES = 600

const NO_THREADS: AnchoredThread[] = []

const STATUS_ICONS = {
  added: FilePlus,
  deleted: FileMinus,
  renamed: FileSymlink,
  copied: FileSymlink,
  modified: FileDiffIcon,
  changed: FileDiffIcon
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

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  )
}

export function FileDiffCard({ file, comments }: { file: FileDiff; comments?: DiffComments }) {
  const lineCount = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  const [expanded, setExpanded] = useState(lineCount <= COLLAPSE_ABOVE_LINES)
  /** Which line the reviewer is currently writing a new comment on. */
  const [composingOn, setComposingOn] = useState<{ side: DiffSide; line: number } | null>(null)

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

  const orphans = threads.filter((thread) => thread.anchor.line === null)
  const unresolvedCount = threads.filter((thread) => thread.resolvedAt === null).length

  const Icon = STATUS_ICONS[file.status]
  const hasBody = file.hunks.length > 0

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        disabled={!hasBody}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
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

        <Icon className="size-4 shrink-0 text-muted-foreground" />

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
      </button>

      {expanded && orphans.length > 0 && comments && (
        <div className="flex flex-col gap-2 border-t border-border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            {orphans.length === 1 ? 'This comment is' : 'These comments are'} on code that is not in
            the diff any more.
          </p>
          {orphans.map((thread) => (
            <CommentThreadCard
              key={thread.id}
              thread={thread}
              mutations={comments.mutations}
              anchorState={thread.anchor.state}
              location={
                thread.line !== null ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    was line {thread.line}
                  </span>
                ) : null
              }
            />
          ))}
        </div>
      )}

      {expanded && hasBody && (
        <div className="border-t border-border">
          <div className="overflow-x-auto">
            <div className="min-w-max font-mono text-xs leading-5">
              {file.hunks.map((hunk, index) => (
                <HunkRows
                  key={`${hunk.header}-${index}`}
                  hunk={hunk}
                  placed={placed}
                  comments={comments}
                  composingOn={composingOn}
                  onCompose={setComposingOn}
                  filePath={file.path}
                />
              ))}
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

interface RowContext {
  placed: Map<string, AnchoredThread[]>
  comments: DiffComments | undefined
  composingOn: { side: DiffSide; line: number } | null
  onCompose: (target: { side: DiffSide; line: number } | null) => void
  filePath: string
}

function HunkRows({ hunk, ...context }: { hunk: DiffHunk } & RowContext) {
  return (
    <>
      <div className="grid grid-cols-[3rem_3rem_1fr] bg-muted/60 text-muted-foreground">
        <span className="col-span-2 border-r border-border" />
        <span className="whitespace-pre px-3 py-0.5">{hunk.header}</span>
      </div>
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
