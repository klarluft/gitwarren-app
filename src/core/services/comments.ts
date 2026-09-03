/**
 * The comment service: threads, replies and resolution.
 *
 * Same contract as the other services - every function re-parses its own input
 * with the shared zod schema, so the UI and the MCP tools cannot disagree about
 * what a valid comment is.
 *
 * The one shape that differs from `repositories.ts` and `reviews.ts`: every
 * write takes a second argument, the `CommentAuthor`. It is not part of the
 * parsed input and cannot be, because the whole value of attribution here rests
 * on the caller being unable to choose it. The IPC layer passes `HUMAN_AUTHOR`
 * because typing into the app is the only way to reach it; the MCP server
 * passes an author derived from the connection handshake. See `shared/actors.ts`.
 */
import { asc, eq, inArray } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import {
  commentThreads,
  comments,
  repositories,
  reviews,
  type CommentRow,
  type CommentThreadRow,
  type RepositoryRow,
  type ReviewRow
} from '../db/schema.js'
import { readReviewDiff } from '../git-compare.js'
import { attachmentReferencesIn, ingestBodyAttachments } from '../attachment-ingest.js'
import { attachmentsBySha, parseAttachmentUrl } from './attachments.js'
import { AppError } from '../../shared/errors.js'
import { authorDisplayName, type CommentAuthor } from '../../shared/actors.js'
import {
  findAnchorFile,
  isInlineAnchor,
  resolveAnchor,
  type AnchorState,
  type DiffSide
} from '../../shared/comment-anchors.js'
import { contextForRange, snippetAt } from '../../shared/comment-snippets.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import {
  anchorSnapshotSchema,
  createThreadInputSchema,
  listCommentsInputSchema,
  removeCommentInputSchema,
  replyToThreadInputSchema,
  setThreadResolvedInputSchema,
  updateCommentInputSchema,
  type AnchorSnapshot,
  type Comment,
  type CommentAttachment,
  type CommentThread
} from '../../shared/schemas.js'

/**
 * Where a thread sits, which is everything needed to link to it.
 *
 * `CommentThread` satisfies this structurally, so a caller holding a whole
 * thread never needs to ask for one.
 */
export interface CommentLocation {
  reviewId: number
  /** Null for a review-level thread, which is not about any particular line. */
  filePath: string | null
  side: DiffSide | null
  line: number | null
}

/** A thread plus where it lands in the diff as it stands right now. */
export interface AnchoredCommentThread extends CommentThread {
  /** Null for a review-level thread, which has no line to drift away from. */
  anchor: { state: AnchorState; line: number | null } | null
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Resolve the attachment tokens in a body into files on disk.
 *
 * The body stays the source of truth about which images a comment has - there
 * is no join table, and deleting an image from the text is all it takes to
 * detach it. That is what makes `attachmentsService.sweep()` correct as a
 * garbage collector rather than a second bookkeeping system to keep in step.
 *
 * A body with no token does no work at all, which is nearly every comment.
 */
function resolveAttachments(body: string): CommentAttachment[] {
  const referenced = attachmentReferencesIn(body)
  if (referenced.length === 0) return []

  const bySha = attachmentsBySha(
    referenced
      .map((reference) => parseAttachmentUrl(reference.url)?.sha)
      .filter((sha): sha is string => sha !== undefined)
  )

  const resolved: CommentAttachment[] = []
  for (const reference of referenced) {
    const sha = parseAttachmentUrl(reference.url)?.sha
    const attachment = sha === undefined ? undefined : bySha.get(sha)
    // A token with no row is a body that outlived its file - a sweep in another
    // process, or a hand-edited body naming an image that never existed. The
    // text still renders; there is simply nothing to hand an agent.
    if (!attachment) continue
    resolved.push({
      url: attachment.url,
      path: attachment.path,
      alt: reference.alt,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      width: attachment.width,
      height: attachment.height
    })
  }
  return resolved
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    threadId: row.threadId,
    author: {
      kind: row.authorKind,
      name: row.authorName,
      label: row.authorLabel,
      session: row.authorSession
    },
    body: row.body,
    attachments: resolveAttachments(row.body),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/**
 * Decode a stored hunk snapshot.
 *
 * Anything unreadable is treated as absent rather than thrown: a snapshot is a
 * nicety for display, and refusing to load a whole discussion because one JSON
 * blob went bad would be the wrong trade by a wide margin.
 */
function toSnapshot(stored: string | null): AnchorSnapshot | null {
  if (stored === null) return null
  try {
    const parsed: unknown = JSON.parse(stored)
    const result = anchorSnapshotSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function toThread(row: CommentThreadRow, threadComments: Comment[]): CommentThread {
  return {
    id: row.id,
    reviewId: row.reviewId,
    filePath: row.filePath,
    side: row.side,
    line: row.line,
    startLine: row.startLine,
    anchorText: row.anchorText,
    anchorSha: row.anchorSha,
    anchorSnapshot: toSnapshot(row.anchorSnapshot),
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    comments: threadComments
  }
}

function requireReview(id: number): ReviewRow {
  const row = getDatabase().select().from(reviews).where(eq(reviews.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No review with id ${id}.`)
  return row
}

function requireRepository(id: number): RepositoryRow {
  const row = getDatabase().select().from(repositories).where(eq(repositories.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No repository with id ${id}.`)
  return row
}

function requireThread(id: number): CommentThreadRow {
  const row = getDatabase().select().from(commentThreads).where(eq(commentThreads.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No comment thread with id ${id}.`)
  return row
}

function requireComment(id: number): CommentRow {
  const row = getDatabase().select().from(comments).where(eq(comments.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No comment with id ${id}.`)
  return row
}

/** Load every thread of a review, each with its messages oldest-first. */
function readThreads(reviewId: number): CommentThread[] {
  const db = getDatabase()

  const threadRows = db
    .select()
    .from(commentThreads)
    .where(eq(commentThreads.reviewId, reviewId))
    .orderBy(asc(commentThreads.createdAt), asc(commentThreads.id))
    .all()

  if (threadRows.length === 0) return []

  const commentRows = db
    .select()
    .from(comments)
    .where(
      inArray(
        comments.threadId,
        threadRows.map((row) => row.id)
      )
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all()

  const byThread = new Map<number, Comment[]>()
  for (const row of commentRows) {
    const list = byThread.get(row.threadId)
    if (list) list.push(toComment(row))
    else byThread.set(row.threadId, [toComment(row)])
  }

  return threadRows.map((row) => toThread(row, byThread.get(row.id) ?? []))
}

/**
 * What the diff said at the moment a thread was opened.
 *
 * Two things are kept, and they do different jobs. `anchorText` is the one line,
 * and it is what `resolveAnchor` re-finds the comment by later. `snapshot` is
 * that line with the few above it - GitHub's `diff_hunk` - and it exists purely
 * so the comment is still readable after the code it was about has been
 * rewritten. Neither is ever updated afterwards; a snapshot that follows the
 * branch is not a snapshot.
 *
 * Both are null when the line is not in the diff - an agent commenting on an
 * unchanged part of a file, or on a stale line number. That is not an error:
 * the comment is still worth keeping, it simply cannot be pinned to a line the
 * reader can see, and `resolveAnchor` reports it as outdated from the start.
 */
async function captureAnchor(
  repositoryPath: string,
  review: ReviewRow,
  filePath: string,
  side: DiffSide,
  line: number,
  startLine: number | null
): Promise<{ anchorText: string | null; anchorSha: string | null; snapshot: AnchorSnapshot | null }> {
  const diff = await readReviewDiff(repositoryPath, review.baseRef, review.headRef, {
    includeUncommitted: true
  })

  const file = findAnchorFile(diff.files, filePath)
  const found = file?.hunks
    .flatMap((hunk) => hunk.lines)
    .find((candidate) => (side === 'base' ? candidate.oldNumber : candidate.newNumber) === line)

  return {
    anchorText: found?.content ?? null,
    anchorSha: diff.head.sha,
    // A comment on a block is snapshotted across the whole block, so an
    // outdated one is still shown against everything it was about rather than
    // against its last line alone.
    snapshot:
      found === undefined
        ? null
        : snippetAt(file, side, line, contextForRange(startLine, line))
  }
}

/**
 * Editing and deleting, without inventing an auth system.
 *
 * The person at the keyboard owns the app and may edit or delete anything in
 * it, exactly as a repository owner can on GitHub. An agent is held to its own
 * messages: it may correct or withdraw what its tool wrote, and cannot touch
 * what a human or a *different* agent wrote. That asymmetry is not security -
 * there is no attacker in this model - it is the difference between an agent
 * fixing its own typo and an agent quietly rewriting someone else's review.
 */
function assertMayModify(actor: CommentAuthor, row: CommentRow): void {
  if (actor.kind === 'human') return
  if (row.authorKind === 'agent' && row.authorName === actor.name) return
  throw new AppError(
    'FORBIDDEN',
    `This comment was written by ${authorDisplayName(toComment(row).author)}. An agent can only edit or delete its own comments.`
  )
}

export const commentsService = {
  /**
   * Every thread on a review, with its messages.
   *
   * Deliberately a pure database read: no git runs here. The renderer already
   * holds the diff it is displaying and anchors the threads against that one
   * with the same shared function, which avoids computing the same diff twice
   * and, more importantly, guarantees the comments are placed against exactly
   * the diff on screen rather than one read a moment later.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async list(input: unknown): Promise<CommentThread[]> {
    const { reviewId } = parse(listCommentsInputSchema, input)
    requireReview(reviewId)
    return readThreads(reviewId)
  },

  /**
   * Which review a thread belongs to, and where in it.
   *
   * Exists for the MCP server, which hands an agent a link back into the GUI
   * for every comment it writes. A reply or an edit returns only a message, so
   * the link's file and line have to be looked up - and reading every thread on
   * the review to find one of them would be absurd.
   *
   * Typed arguments rather than `unknown`, unlike everything else here: this is
   * not reachable from a tool call or an IPC channel, so there is no untrusted
   * boundary to re-parse at.
   */
  locate(reference: { threadId: number } | { commentId: number }): CommentLocation {
    const threadId =
      'threadId' in reference ? reference.threadId : requireComment(reference.commentId).threadId
    const thread = requireThread(threadId)

    return {
      reviewId: thread.reviewId,
      filePath: thread.filePath,
      side: thread.side,
      line: thread.line
    }
  },

  /**
   * The same threads, each resolved against the current diff.
   *
   * This is the shape agents get. They have no diff in hand and no way to run
   * the anchoring themselves, and an agent acting on a comment needs to know
   * whether it still points at live code.
   */
  async listAnchored(input: unknown): Promise<AnchoredCommentThread[]> {
    const { reviewId } = parse(listCommentsInputSchema, input)
    const review = requireReview(reviewId)
    const threads = readThreads(reviewId)

    const inline = threads.filter((thread) => isInlineAnchor(thread))
    if (inline.length === 0) {
      return threads.map((thread) => ({ ...thread, anchor: null }))
    }

    const repository = requireRepository(review.repositoryId)
    const diff = await readReviewDiff(repository.path, review.baseRef, review.headRef, {
      includeUncommitted: true
    })

    return threads.map((thread) => {
      if (!isInlineAnchor(thread)) return { ...thread, anchor: null }
      const file = findAnchorFile(diff.files, thread.filePath)
      return {
        ...thread,
        anchor: resolveAnchor(file, {
          filePath: thread.filePath,
          side: thread.side,
          line: thread.line,
          startLine: thread.startLine,
          anchorText: thread.anchorText
        })
      }
    })
  },

  /**
   * Start a discussion - on the review as a whole, or on a line of the diff.
   *
   * A thread is never created empty: the opening message is written in the same
   * transaction, so a failed insert cannot leave a headless thread behind for
   * the UI to render as a blank card.
   */
  async createThread(input: unknown, actor: CommentAuthor): Promise<CommentThread> {
    const {
      reviewId,
      body: written,
      filePath,
      side,
      line,
      startLine: requestedStart
    } = parse(createThreadInputSchema, input)
    const review = requireReview(reviewId)
    const repositoryPath = requireRepository(review.repositoryId).path

    const body = await ingestBodyAttachments(written, { repositoryRoot: repositoryPath })

    // A range of one is not a range. Normalising here means every consumer can
    // read "startLine !== null" as "this comment is about a block", instead of
    // each of them having to compare the two numbers.
    const startLine =
      requestedStart === undefined || line === undefined || requestedStart >= line
        ? null
        : requestedStart

    let anchorText: string | null = null
    let anchorSha: string | null = null
    let anchorSnapshot: string | null = null
    if (filePath !== undefined && line !== undefined) {
      const captured = await captureAnchor(repositoryPath, review, filePath, side, line, startLine)
      anchorText = captured.anchorText
      anchorSha = captured.anchorSha
      anchorSnapshot = captured.snapshot === null ? null : JSON.stringify(captured.snapshot)
    }

    const timestamp = nowIso()
    const db = getDatabase()

    return db.transaction((tx) => {
      const threadRow = tx
        .insert(commentThreads)
        .values({
          reviewId,
          filePath: filePath ?? null,
          side: filePath === undefined ? null : side,
          line: line ?? null,
          startLine,
          anchorText,
          anchorSha,
          anchorSnapshot,
          resolvedAt: null,
          resolvedBy: null,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        .returning()
        .get()

      const commentRow = tx
        .insert(comments)
        .values({
          threadId: threadRow.id,
          authorKind: actor.kind,
          authorName: actor.name,
          authorLabel: actor.label,
          authorSession: actor.session,
          body,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        .returning()
        .get()

      // A new discussion is activity on the review; the list sorts by it.
      tx.update(reviews).set({ updatedAt: timestamp }).where(eq(reviews.id, reviewId)).run()

      return toThread(threadRow, [toComment(commentRow)])
    })
  },

  /** Add a message to an existing thread. */
  async reply(input: unknown, actor: CommentAuthor): Promise<Comment> {
    const { threadId, body: written } = parse(replyToThreadInputSchema, input)
    const thread = requireThread(threadId)

    const review = requireReview(thread.reviewId)
    const body = await ingestBodyAttachments(written, {
      repositoryRoot: requireRepository(review.repositoryId).path
    })

    const timestamp = nowIso()
    const db = getDatabase()

    return db.transaction((tx) => {
      const row = tx
        .insert(comments)
        .values({
          threadId,
          authorKind: actor.kind,
          authorName: actor.name,
          authorLabel: actor.label,
          authorSession: actor.session,
          body,
          createdAt: timestamp,
          updatedAt: timestamp
        })
        .returning()
        .get()

      tx
        .update(commentThreads)
        .set({ updatedAt: timestamp })
        .where(eq(commentThreads.id, threadId))
        .run()
      tx.update(reviews).set({ updatedAt: timestamp }).where(eq(reviews.id, thread.reviewId)).run()

      return toComment(row)
    })
  },

  /**
   * Edit a message. The body is replaced; authorship never is - a comment does
   * not change hands because someone fixed a typo in it.
   */
  async update(input: unknown, actor: CommentAuthor): Promise<Comment> {
    const { id, body: written } = parse(updateCommentInputSchema, input)
    const existing = requireComment(id)
    assertMayModify(actor, existing)

    const thread = requireThread(existing.threadId)
    const review = requireReview(thread.reviewId)
    const body = await ingestBodyAttachments(written, {
      repositoryRoot: requireRepository(review.repositoryId).path
    })

    const row = getDatabase()
      .update(comments)
      .set({ body, updatedAt: nowIso() })
      .where(eq(comments.id, id))
      .returning()
      .get()

    return toComment(row)
  },

  /**
   * Delete a message, and the thread with it when it was the last one.
   *
   * An empty thread is not a thing the UI can draw or a reader can act on, so
   * it is cleaned up here rather than left as a tombstone.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async remove(input: unknown, actor: CommentAuthor): Promise<{ id: number; threadRemoved: boolean }> {
    const { id } = parse(removeCommentInputSchema, input)
    const existing = requireComment(id)
    assertMayModify(actor, existing)

    const db = getDatabase()
    return db.transaction((tx) => {
      tx.delete(comments).where(eq(comments.id, id)).run()

      const remaining = tx
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, existing.threadId))
        .all()

      if (remaining.length === 0) {
        tx.delete(commentThreads).where(eq(commentThreads.id, existing.threadId)).run()
        return { id, threadRemoved: true }
      }

      tx
        .update(commentThreads)
        .set({ updatedAt: nowIso() })
        .where(eq(commentThreads.id, existing.threadId))
        .run()
      return { id, threadRemoved: false }
    })
  },

  /**
   * Mark a discussion settled, or reopen it.
   *
   * Who resolved it is stored as a plain display name rather than a reference,
   * for the same reason comment authorship is denormalised: the agent that
   * resolved this thread may not exist by the time anyone reads it.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async setResolved(input: unknown, actor: CommentAuthor): Promise<CommentThread> {
    const { threadId, resolved } = parse(setThreadResolvedInputSchema, input)
    const thread = requireThread(threadId)

    const timestamp = nowIso()
    const db = getDatabase()

    const row = db
      .update(commentThreads)
      .set({
        resolvedAt: resolved ? timestamp : null,
        resolvedBy: resolved ? authorDisplayName(actor) : null,
        updatedAt: timestamp
      })
      .where(eq(commentThreads.id, threadId))
      .returning()
      .get()

    const threadComments = db
      .select()
      .from(comments)
      .where(eq(comments.threadId, thread.id))
      .orderBy(asc(comments.createdAt), asc(comments.id))
      .all()
      .map(toComment)

    return toThread(row, threadComments)
  },

  /** How many threads a review has, and how many are still open. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async counts(reviewId: number): Promise<{ threads: number; unresolved: number }> {
    const rows = getDatabase()
      .select({ resolvedAt: commentThreads.resolvedAt })
      .from(commentThreads)
      .where(eq(commentThreads.reviewId, reviewId))
      .all()

    return {
      threads: rows.length,
      unresolved: rows.filter((row) => row.resolvedAt === null).length
    }
  }
}

export type CommentsService = typeof commentsService
