/**
 * GitHub-style rendering of a parsed diff.
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
 */
import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileDiff as FileDiffIcon,
  FileMinus,
  FilePlus,
  FileSymlink
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { DiffHunk, DiffLine, FileDiff } from '@shared/git'

/** Files longer than this arrive collapsed; see the note above. */
const COLLAPSE_ABOVE_LINES = 600

const STATUS_ICONS = {
  added: FilePlus,
  deleted: FileMinus,
  renamed: FileSymlink,
  copied: FileSymlink,
  modified: FileDiffIcon,
  changed: FileDiffIcon
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  )
}

export function FileDiffCard({ file }: { file: FileDiff }) {
  const lineCount = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  const [expanded, setExpanded] = useState(lineCount <= COLLAPSE_ABOVE_LINES)

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

        <span data-selectable className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.oldPath && file.oldPath !== file.path && (
            <span className="text-muted-foreground">{file.oldPath} → </span>
          )}
          {file.path}
        </span>

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

      {expanded && hasBody && (
        <div className="overflow-x-auto border-t border-border">
          <div className="min-w-max font-mono text-xs leading-5">
            {file.hunks.map((hunk, index) => (
              <HunkRows key={`${hunk.header}-${index}`} hunk={hunk} />
            ))}
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

function HunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <div className="grid grid-cols-[3rem_3rem_1fr] bg-muted/60 text-muted-foreground">
        <span className="col-span-2 border-r border-border" />
        <span className="whitespace-pre px-3 py-0.5">{hunk.header}</span>
      </div>
      {hunk.lines.map((line, index) => (
        <LineRow key={index} line={line} />
      ))}
    </>
  )
}

function LineRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        'grid grid-cols-[3rem_3rem_1fr]',
        line.type === 'insert' && 'bg-success/10',
        line.type === 'delete' && 'bg-destructive/10'
      )}
    >
      <Gutter value={line.oldNumber} />
      <Gutter value={line.newNumber} />
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
  )
}

function Gutter({ value }: { value: number | null }) {
  return (
    <span className="select-none border-r border-border px-2 text-right tabular-nums text-muted-foreground/70">
      {value ?? ''}
    </span>
  )
}
