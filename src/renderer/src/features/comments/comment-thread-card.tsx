/**
 * One discussion: its messages, a reply box, and the resolve control.
 *
 * The shape follows GitHub's review threads because that shape is right and
 * people already know it - messages stacked oldest first, one reply box at the
 * bottom, resolving collapses rather than deletes. Two details differ:
 *
 *  - A resolved thread collapses to a single summary line, but the line names
 *    who resolved it, because here that may have been an agent.
 *  - An anchored thread can be marked "moved" or "outdated". Neither exists on
 *    GitHub, where a comment is pinned to a commit; here the branch keeps
 *    moving under the review, so the thread has to say how confident it is
 *    about the line it is sitting next to.
 */
import { useState } from 'react'
import { Check, CircleDot, MessageSquare, MoreHorizontal, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Markdown } from '@/components/markdown'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { AuthorAvatar, AuthorByline } from './comment-author'
import { CommentComposer } from './comment-composer'
import type { CommentMutations } from './use-comments'
import type { AnchorState } from '@shared/comment-anchors'
import type { Comment, CommentThread } from '@shared/schemas'

interface CommentThreadCardProps {
  thread: CommentThread
  mutations: CommentMutations
  /** Where this thread sits in the diff on screen. Null for review-level threads. */
  anchorState?: AnchorState | null
  /** Shown above the messages when the thread is listed away from its line. */
  location?: React.ReactNode
  className?: string
}

const ANCHOR_NOTE: Record<Exclude<AnchorState, 'anchored'>, { label: string; title: string }> = {
  moved: {
    label: 'moved',
    title:
      'The code this comment was left on is still here, but it has shifted to a different line since the comment was written.'
  },
  outdated: {
    label: 'outdated',
    title:
      'The line this comment was left on is not in the diff any more - it was changed, or it was never part of the diff.'
  }
}

export function CommentThreadCard({
  thread,
  mutations,
  anchorState = null,
  location,
  className
}: CommentThreadCardProps) {
  const [replying, setReplying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const resolved = thread.resolvedAt !== null
  const [expanded, setExpanded] = useState(!resolved)
  const note = anchorState && anchorState !== 'anchored' ? ANCHOR_NOTE[anchorState] : null

  async function toggleResolved(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await mutations.setResolved(thread.id, !resolved)
      setExpanded(resolved)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  if (resolved && !expanded) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2',
          className
        )}
      >
        <Check className="size-4 shrink-0 text-success" />
        <span className="text-xs text-muted-foreground">
          Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ''} ·{' '}
          {thread.comments.length === 1 ? '1 comment' : `${thread.comments.length} comments`}
        </span>
        {location}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setExpanded(true)}
        >
          Show
        </Button>
      </div>
    )
  }

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      {(location || note || resolved) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
          {location}
          {note && (
            <Badge variant="warning" title={note.title}>
              <CircleDot />
              {note.label}
            </Badge>
          )}
          {resolved && (
            <Badge variant="success" title={`Resolved by ${thread.resolvedBy ?? 'someone'}`}>
              <Check />
              resolved
            </Badge>
          )}
        </div>
      )}

      <div className="divide-y divide-border">
        {thread.comments.map((comment) => (
          <CommentRow key={comment.id} comment={comment} mutations={mutations} />
        ))}
      </div>

      {error !== null && (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {errorMessage(error)}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border bg-muted/20 px-3 py-2">
        {replying ? (
          <CommentComposer
            className="w-full"
            placeholder="Reply"
            submitLabel="Reply"
            autoFocus
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await mutations.reply({ threadId: thread.id, body })
              setReplying(false)
            }}
          />
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => setReplying(true)}>
              <MessageSquare />
              Reply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={busy}
              onClick={() => void toggleResolved()}
            >
              <Check />
              {resolved ? 'Reopen' : 'Resolve'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * One message.
 *
 * Edit and delete are offered on every comment, agent-written ones included.
 * The service is the thing that decides what is allowed - a person may edit
 * anything in their own app, an agent only its own - so the UI does not
 * duplicate that rule, it just reports the refusal if one comes back.
 */
function CommentRow({
  comment,
  mutations
}: {
  comment: Comment
  mutations: CommentMutations
}) {
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const edited = comment.updatedAt !== comment.createdAt

  async function remove(): Promise<void> {
    setError(null)
    try {
      await mutations.remove(comment.id)
    } catch (caught) {
      setError(caught)
      setConfirmingDelete(false)
    }
  }

  return (
    <div className="flex gap-3 px-3 py-3">
      <AuthorAvatar author={comment.author} className="mt-0.5" />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <AuthorByline author={comment.author} timestamp={comment.createdAt} edited={edited} />

          {!editing && (
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip label="Edit this comment">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground"
                  aria-label="Edit this comment"
                  onClick={() => setEditing(true)}
                >
                  <MoreHorizontal />
                </Button>
              </Tooltip>
              <Tooltip label={confirmingDelete ? 'Click again to delete' : 'Delete this comment'}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground hover:text-destructive"
                  aria-label="Delete this comment"
                  onClick={() => (confirmingDelete ? void remove() : setConfirmingDelete(true))}
                  onBlur={() => setConfirmingDelete(false)}
                >
                  <Trash2 />
                  {confirmingDelete && <span className="text-xs">Sure?</span>}
                </Button>
              </Tooltip>
            </div>
          )}
        </div>

        {editing ? (
          <CommentComposer
            className="mt-2"
            initialValue={comment.body}
            submitLabel="Save"
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              await mutations.edit(comment.id, body)
              setEditing(false)
            }}
          />
        ) : (
          <Markdown body={comment.body} className="mt-1" />
        )}

        {error !== null && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {errorMessage(error)}
          </p>
        )}
      </div>
    </div>
  )
}
