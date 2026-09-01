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
