/**
 * The byline on a comment.
 *
 * The only rule this component enforces, and the reason it exists rather than
 * being inlined three times: a machine-written comment always looks like one.
 * The avatar is square and the badge says AI; a person's is round and says
 * nothing. A reader skimming a thread should never have to work out which of
 * these they are reading.
 *
 * Agents are tinted by identity rather than all sharing one colour, so a review
 * worked by Claude Code and Codex at once reads as two participants. The tint
 * is derived from the author key, so the same agent keeps the same colour
 * across threads and across restarts without anything being stored.
 */
import { Bot, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { absoluteTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AGENT_SUFFIX, authorInitials, authorKey, type CommentAuthor } from '@shared/actors'

/**
 * Tints for agent avatars. Deliberately muted - this is a way to tell two
 * participants apart at a glance, not a highlight.
 */
const AGENT_TINTS = [
  'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  'bg-teal-500/15 text-teal-600 dark:text-teal-400'
]

/** Stable string hash, so one agent keeps one colour without storing it. */
function tintFor(key: string): string {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  return AGENT_TINTS[Math.abs(hash) % AGENT_TINTS.length] as string
}

export function AuthorAvatar({
  author,
  className
}: {
  author: CommentAuthor
  className?: string
}) {
  const isAgent = author.kind === 'agent'

  return (
    <span
      aria-hidden
      title={isAgent ? `${author.name} (AI)` : author.name}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center text-[10px] font-semibold',
        // Square for machines, round for people. The shape carries the same
        // information as the badge, so it survives being skimmed.
        isAgent ? cn('rounded-md', tintFor(authorKey(author))) : 'rounded-full bg-muted text-muted-foreground',
        className
      )}
    >
      {isAgent ? authorInitials(author) : <User className="size-3.5" />}
    </span>
  )
}

export function AuthorByline({
  author,
  timestamp,
  edited
}: {
  author: CommentAuthor
  timestamp: string
  /** True when the message has been changed since it was written. */
  edited?: boolean
}) {
  const isAgent = author.kind === 'agent'

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="truncate text-sm font-medium">{author.name}</span>

      {isAgent && (
        <Badge
          variant="outline"
          title={
            author.session
              ? `Written over MCP by ${author.name} (session ${author.session})`
              : `Written over MCP by ${author.name}`
          }
        >
          <Bot />
          {AGENT_SUFFIX}
        </Badge>
      )}

      {/* The session label is the agent's own handle for this run of itself,
          and it is what tells two concurrent sessions of one tool apart. */}
      {author.label && (
        <span className="truncate font-mono text-xs text-muted-foreground" title="Agent session">
          {author.label}
        </span>
      )}

      <span className="text-xs text-muted-foreground" title={absoluteTime(timestamp)}>
        {relativeTime(timestamp)}
      </span>

      {edited && (
        <span className="text-xs text-muted-foreground" title="This comment was edited">
          · edited
        </span>
      )}
    </div>
  )
}
