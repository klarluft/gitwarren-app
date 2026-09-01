/**
 * Drizzle table definitions.
 *
 * Only durable facts live here. Branch, existence and anything else that git
 * owns is read live (see `core/git.ts`) and never cached, so the app can't show
 * a branch name that stopped being true ten minutes ago.
 */
import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const repositories = sqliteTable(
  'repositories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * Canonical absolute path to the repository root. UNIQUE is the backstop
     * that enforces "one row per repository"; the path is resolved through
     * `git rev-parse --show-toplevel` + realpath before it ever gets here.
     */
    path: text('path').notNull().unique(),
    name: text('name').notNull(),
    /** ISO-8601 UTC strings - readable in a SQLite browser, no timezone traps. */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [index('repositories_name_idx').on(table.name)]
)

export type RepositoryRow = typeof repositories.$inferSelect
export type NewRepositoryRow = typeof repositories.$inferInsert

/**
 * A review: two points in a repository, plus the discussion that will hang off
 * them.
 *
 * Only the ref *names* are stored, never the commits they resolved to. That is
 * the same "durable facts only" rule the repositories table follows, and here it
 * is load-bearing rather than incidental: a review is meant to follow its branch
 * as work continues on it - including work that has not been committed yet - so
 * pinning shas at creation time would defeat the feature. Commits, diffs and
 * uncommitted state are recomputed from git on every visit.
 */
export const reviews = sqliteTable(
  'reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * Deleting a repository takes its reviews with it. They are meaningless
     * without it, and leaving orphans behind would put a "does the parent still
     * exist" branch in front of every read.
     */
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** Ref names as the user chose them; resolved live on every read. */
    baseRef: text('base_ref').notNull(),
    headRef: text('head_ref').notNull(),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    /** Set when the review is closed, cleared again when it is reopened. */
    closedAt: text('closed_at')
  },
  (table) => [index('reviews_repository_idx').on(table.repositoryId, table.status)]
)

export type ReviewRow = typeof reviews.$inferSelect
export type NewReviewRow = typeof reviews.$inferInsert

/**
 * A comment thread: one discussion, either about the review as a whole or
 * anchored to a line of the diff.
 *
 * The thread/comment split is GitHub's, and it earns its place: resolving is a
 * property of the discussion, not of any one message, and a reply must not be
 * able to drift away from the line its parent was about.
 *
 * The anchor columns are the interesting part. GitWarren reviews follow their
 * refs rather than pinning a sha (see the `reviews` comment above), so the diff
 * under a comment keeps moving - a line inserted above shifts every line number
 * below it. Storing the line number alone would silently point old comments at
 * new code. `anchorText` is the snapshot that makes the drift detectable: at
 * read time the line is re-found by its text, and a thread whose text is gone
 * is shown as outdated rather than pinned to a line it no longer describes.
 */
export const commentThreads = sqliteTable(
  'comment_threads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Deleting a review takes its discussion with it, as with repositories. */
    reviewId: integer('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    /**
     * Path on the side the comment was left on. NULL means a review-level
     * thread - the conversation tab - which is why every anchor column is
     * nullable together.
     */
    filePath: text('file_path'),
    /** Which side of the diff `line` numbers: the base (removed) or head side. */
    side: text('side', { enum: ['base', 'head'] }),
    /** Line number on `side`, as it stood when the thread was opened. */
    line: integer('line'),
    /**
     * The text of that line when the thread was opened. NULL when the line was
     * not in the diff at the time, which marks the thread outdated on arrival.
     */
    anchorText: text('anchor_text'),
    /** Head sha at the time, so the UI can say what the comment was written against. */
    anchorSha: text('anchor_sha'),
    resolvedAt: text('resolved_at'),
    /** Display name of whoever resolved it; NULL while the thread is open. */
    resolvedBy: text('resolved_by'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    /** Bumped by every reply, so "newest activity first" is one column read. */
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('comment_threads_review_idx').on(table.reviewId, table.updatedAt),
    index('comment_threads_file_idx').on(table.reviewId, table.filePath)
  ]
)

export type CommentThreadRow = typeof commentThreads.$inferSelect
export type NewCommentThreadRow = typeof commentThreads.$inferInsert

/**
 * One message in a thread.
 *
 * Authorship is denormalised onto every row on purpose. There is no users
 * table and there will not be one: GitWarren is a single-person app with no
 * auth, and an "author" here is not an account but a description of where a
 * message came from - the person at the keyboard, or a named agent process that
 * has since exited. Copying the label onto the row keeps that description true
 * forever, which a foreign key to a mutable identity would not.
 */
export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: integer('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    /** 'human' for anything typed in the app, 'agent' for anything over MCP. */
    authorKind: text('author_kind', { enum: ['human', 'agent'] }).notNull(),
    /**
     * Display name. Always "Human" from the UI. For an agent this is derived
     * from the MCP `clientInfo` handshake rather than self-reported, so every
     * session of the same tool lands on the same name.
     */
    authorName: text('author_name').notNull(),
    /**
     * Optional handle an agent may supply to tell two of its own concurrent
     * sessions apart ("auth-refactor"). NULL for humans and for agents that
     * did not bother.
     */
    authorLabel: text('author_label'),
    /**
     * Per-MCP-process id. stdio gives one server process per agent session, so
     * this distinguishes two concurrent sessions of the same tool even when
     * neither supplied a label. NULL for humans.
     */
    authorSession: text('author_session'),
    body: text('body').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [index('comments_thread_idx').on(table.threadId, table.createdAt)]
)

export type CommentRow = typeof comments.$inferSelect
export type NewCommentRow = typeof comments.$inferInsert
