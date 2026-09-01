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
