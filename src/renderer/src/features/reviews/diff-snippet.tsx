/**
 * The few lines of code a comment is about, shown away from the diff.
 *
 * The conversation tab needs this because a line comment read on its own is
 * close to useless - "this should be awaited" means nothing without the line it
 * points at. GitHub solves it by printing a small hunk above each review
 * comment, and the same shape works here.
 *
 * It renders the diff's own visual language deliberately: same mono column,
 * same gutter, same add/delete colouring, so a snippet reads as a piece of the
 * Files changed tab rather than as a quotation of it. The commented line is the
 * last one and is marked, because that is where the eye should stop.
 *
 * The header is a button: the snippet is a pointer into the diff, and a
 * reviewer who wants the surrounding code should be one click from it.
 */
import { ChevronRight, FileCode } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AnchorState, DiffSide } from '@shared/comment-anchors'
import type { DiffLine } from '@shared/git'

interface DiffSnippetProps {
  filePath: string
  side: DiffSide
  /** Line the comment sits on now, or null when it cannot be placed. */
  line: number | null
  lines: DiffLine[]
  /** True when the snippet starts mid-hunk, so the lead-in is cut short. */
  clipped?: boolean
  state?: AnchorState
  onOpen?: () => void
  className?: string
}

export function DiffSnippet({
  filePath,
  side,
  line,
  lines,
  clipped = false,
  state = 'anchored',
  onOpen,
  className
}: DiffSnippetProps) {
  // "was line" matches how the Files changed tab labels a thread it can no
  // longer place: the number is where the comment used to sit, not where the
  // reader will find it now.
  const lineLabel =
    line === null
      ? null
      : state === 'outdated'
        ? `was line ${line}`
        : side === 'base'
          ? `removed line ${line}`
          : `line ${line}`

  return (
    <div className={cn('overflow-hidden rounded-md border border-border bg-muted/20', className)}>
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? `Open ${filePath} in Files changed` : filePath}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          onOpen && 'transition-colors hover:bg-muted/60'
        )}
      >
        <FileCode className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" data-selectable>
          {filePath}
        </span>
        {lineLabel && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{lineLabel}</span>
        )}
        {state === 'moved' && (
          <Badge
            variant="warning"
            title="The code this comment was left on has shifted to a different line since it was written."
          >
            moved
          </Badge>
        )}
        {state === 'outdated' && (
          <Badge
            variant="warning"
            title="The line this comment was left on is not in the diff any more - it was changed, or it was never part of the diff."
          >
            outdated
          </Badge>
        )}
        {onOpen && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
      </button>

      {lines.length > 0 && (
        <div className="overflow-x-auto border-t border-border bg-card">
          <div className="min-w-max font-mono text-xs leading-5">
            {clipped && (
              <div className="grid grid-cols-[3rem_1fr] text-muted-foreground">
                <span className="select-none border-r border-border px-2 text-right">…</span>
                <span className="px-3" />
              </div>
            )}
            {lines.map((snippetLine, index) => {
              const number = side === 'base' ? snippetLine.oldNumber : snippetLine.newNumber
              const isAnchor = index === lines.length - 1

              return (
                <div
                  key={index}
                  className={cn(
                    'grid grid-cols-[3rem_1fr]',
                    snippetLine.type === 'insert' && 'bg-success/10',
                    snippetLine.type === 'delete' && 'bg-destructive/10',
                    isAnchor && 'bg-warning/10 font-medium'
                  )}
                >
                  <span className="select-none border-r border-border px-2 text-right tabular-nums text-muted-foreground/70">
                    {number ?? ''}
                  </span>
                  <span
                    data-selectable
                    className={cn(
                      'whitespace-pre px-3',
                      snippetLine.type === 'insert' && 'text-success',
                      snippetLine.type === 'delete' && 'text-destructive'
                    )}
                  >
                    <span aria-hidden className="select-none opacity-60">
                      {snippetLine.type === 'insert'
                        ? '+'
                        : snippetLine.type === 'delete'
                          ? '-'
                          : ' '}
                    </span>
                    {snippetLine.content}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
