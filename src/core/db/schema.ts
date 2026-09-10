/**
 * Drizzle table definitions.
 *
 * Only durable facts live here. Branch, existence and anything else that git
 * owns is read live (see `core/git.ts`) and never cached, so the app can't show
 * a branch name that stopped being true ten minutes ago.
 */
import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * A person, as opposed to a name printed next to a comment.
 *
 * GitWarren still has no accounts and no auth, and this table does not add
 * either. What it adds is a *stable subject* for the one human in the system,
 * which is the piece that stops working the moment there is more than one
 * machine: "Human" is a fine label on one laptop and meaningless as soon as a
 * review can be read from a second one, where the local user of *that* install
 * is also called "Human".
 *
 * So a principal is identified by where the claim comes from rather than by
 * what it is called. `kind` is the authority and `identifier` is what that
 * authority says. For `local` the identifier is this install's instance id
 * (`core/instance.ts`), which makes the local user of each install a distinct,
 * durable subject. `tailscale` is the second authority, and the reason the
 * shape is a pair rather than a plain string: Tailscale reports the same login
 * on every device the user owns, so one principal spans their machines while
 * the local ones stay per-install.
 *
 * `displayName` is still denormalised onto every comment row, exactly as
 * before. This table is what those rows now *point at*, not a replacement for
 * what they carry - see the note on `comments` below.
 */
export const principals = sqliteTable(
  'principals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * Which authority vouches for `identifier`. `local` is the owner of one
     * install; `tailscale` arrives with the tailnet listener and carries a
     * login that is the same on all of the user's devices.
     */
    kind: text('kind', { enum: ['local', 'tailscale'] }).notNull(),
    /** Instance id for `local`, the login for `tailscale`. Never displayed. */
    identifier: text('identifier').notNull(),
    /** What to call them. "Human" for the local principal, as the UI always has. */
    displayName: text('display_name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  // One row per (authority, subject). This is what makes seeding the local
  // principal idempotent when the GUI and the MCP server open the database at
  // the same moment.
  (table) => [uniqueIndex('principals_identity_idx').on(table.kind, table.identifier)]
)

export type PrincipalRow = typeof principals.$inferSelect
export type NewPrincipalRow = typeof principals.$inferInsert

/**
 * Another machine this install can reach, and how to reach it.
 *
 * The table `repositories.host_id` has been pointing at since M0. A row here is
 * a *route*, not a copy of anything: the host owns its repositories, its SQLite
 * and its git, and everything this install knows about what is over there it
 * learned by asking. Nothing here is replicated state, which is why there is no
 * `synced_at` and never will be.
 *
 * ## Why the instance id is nullable
 *
 * `instanceId` is the host's own identity (`shared/instance-id.ts`), and it is
 * what `repositories.host_id` actually stores - so it is tempting to require it
 * at insert. It cannot be, because of the order the world happens in: a person
 * types an SSH target into a form and presses Add, and at that moment nobody
 * knows the instance id, or whether the host answers at all. It is learned on
 * the first successful connect and written back.
 *
 * That also makes NULL the honest record of a host we have never reached: a row
 * with a target and no instance id is a host that has been *described* but not
 * yet *met*, and the Hosts screen can say exactly that instead of showing a
 * fabricated identity next to a machine that may not exist.
 *
 * Keeping identity apart from address is what M6 will need: a host's address
 * changes (DHCP, a renamed tailnet node, a different SSH user) while the
 * machine holding the repositories does not. When discovery starts proposing
 * peers, the instance id is what says "you already know this one" - and it is
 * the only field a `repositories.host_id` may be matched against.
 *
 * ## What `kind` will and will not grow into
 *
 * `ssh` here, `wsl` at M5, `websocket` at M6. It discriminates over *carriers*,
 * not over operating systems: what a host runs is discovered by asking it
 * (`uname -sm`, for M4.2's installer), never declared in a form, because a
 * person choosing "Linux" from a dropdown is a person who can choose wrong.
 */
export const hosts = sqliteTable(
  'hosts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * The host's own instance id, learned on the first successful connect and
     * NULL until then. This is what `repositories.host_id` holds.
     */
    instanceId: text('instance_id'),
    /** What the person calls this machine. Theirs to choose; never matched on. */
    label: text('label').notNull(),
    /** Which carrier reaches it. */
    kind: text('kind', { enum: ['ssh'] })
      .notNull()
      .default('ssh'),
    /**
     * What the carrier is handed. For `ssh`, a destination `ssh` understands -
     * and it carries the Unix user, because spike S1 found that a bare MagicDNS
     * name requests the *client's* username and is refused by the tailnet
     * policy. `xfor@pc-wsl`, not `pc-wsl`.
     */
    target: text('target').notNull(),
    /**
     * How an editor on *this* machine names a file over there:
     * `ssh-remote+<target>` for VS Code, per spike S4. Kept apart from `target`
     * because the two coincide today and stop coinciding at M5, where the
     * carrier is `wsl.exe -d Ubuntu` and the editor form is `wsl+Ubuntu`. NULL
     * means "derive it from the target", which is right until someone's SSH
     * config aliases differ from their editor's.
     */
    editorTarget: text('editor_target'),
    /**
     * When this host last answered a request. A fact about the past, so it is
     * safe to store; whether the host is reachable *now* is not, and is never
     * written down - the Hosts screen asks the carrier, which knows.
     */
    lastSeenAt: text('last_seen_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    /**
     * One row per target per carrier. Adding `pc-wsl` twice is a mistake worth
     * catching in the database rather than in the form, since a form is not the
     * only thing that will insert here once M6 discovers peers.
     */
    uniqueIndex('hosts_kind_target_idx').on(table.kind, table.target),
    /**
     * And one row per machine. Partial, because NULL is how "not met yet" is
     * spelled and SQLite treats NULLs in a unique index as all distinct - the
     * same rule, and the same remedy, as the repositories indexes below.
     *
     * This is the index that catches the interesting case: one machine added
     * twice under two names (`pc-wsl` and `xfor@100.78.0.23`). Neither label
     * nor target can see that they are the same box; the instance id it reports
     * on first connect can.
     */
    uniqueIndex('hosts_instance_idx')
      .on(table.instanceId)
      .where(sql`${table.instanceId} is not null`)
  ]
)

export type HostRow = typeof hosts.$inferSelect
export type NewHostRow = typeof hosts.$inferInsert

export const repositories = sqliteTable(
  'repositories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /**
     * The install that owns this repository, or NULL for this one.
     *
     * A host owns its repositories: SQLite, git and the MCP server for a repo
     * all live on the machine the repo is on, and a row here for a repository
     * on another host is a *reference* to it, never a copy. NULL rather than
     * this install's own instance id, so that nothing has to be rewritten when
     * a data directory is moved or restored onto a machine that mints a new id.
     */
    hostId: text('host_id'),
    /**
     * Canonical absolute path to the repository root, on its host. The path is
     * resolved through `git rev-parse --show-toplevel` + realpath before it
     * ever gets here; the unique indexes below are the backstop that enforces
     * "one row per repository per host".
     */
    path: text('path').notNull(),
    name: text('name').notNull(),
    /** ISO-8601 UTC strings - readable in a SQLite browser, no timezone traps. */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('repositories_name_idx').on(table.name),
    /**
     * One row per path per host.
     *
     * This index alone is not enough, and the reason is a SQLite rule worth
     * stating out loud: NULLs in a unique index are all distinct from one
     * another, so `(NULL, '/work/app')` twice would satisfy it perfectly. Since
     * NULL is precisely how a *local* repository is spelled, relying on this
     * index by itself would quietly retire the duplicate guard that local
     * repositories have always had.
     */
    uniqueIndex('repositories_host_path_idx').on(table.hostId, table.path),
    /** Which is why local rows get their own index, where there is no NULL to
     *  make two identical paths look different. Together the two say what
     *  `UNIQUE(path)` used to say, once per host. */
    uniqueIndex('repositories_local_path_idx')
      .on(table.path)
      .where(sql`${table.hostId} is null`)
  ]
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
 * `anchorSnapshot` is what is shown when that happens - the code as it read at
 * the time, so an outdated comment is still legible.
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
    /**
     * Line number on `side`, as it stood when the thread was opened. For a
     * comment on a block of code this is the *last* line of it, because that is
     * the line `anchorText` describes and therefore the one the whole range
     * follows when the code moves.
     */
    line: integer('line'),
    /**
     * First line of the range, for a comment about several lines at once. NULL
     * for a comment on one line, which is the overwhelming majority - storing
     * `line` twice would make every single-line thread look like a range.
     */
    startLine: integer('start_line'),
    /**
     * The text of that line when the thread was opened. NULL when the line was
     * not in the diff at the time, which marks the thread outdated on arrival.
     */
    anchorText: text('anchor_text'),
    /** Head sha at the time, so the UI can say what the comment was written against. */
    anchorSha: text('anchor_sha'),
    /**
     * The commented line and the few above it, as JSON, exactly as they read
     * when the thread was opened - GitHub's `diff_hunk` by another name.
     *
     * `anchorText` is enough to notice that the code has been rewritten; it is
     * not enough to show anyone what the comment was about once it has. This
     * column is what an outdated comment is drawn against, so a discussion
     * survives the code it was about. Written once and never updated: the
     * moment it tracks the current diff it stops being a record of anything.
     * NULL for review-level threads, for a line that was not in the diff, and
     * for threads created before this column existed.
     */
    anchorSnapshot: text('anchor_snapshot'),
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
 * Authorship is denormalised onto every row on purpose. An "author" here is not
 * an account but a description of where a message came from - the person at the
 * keyboard, or a named agent process that has since exited. Copying the label
 * onto the row keeps that description true forever, which a foreign key to a
 * mutable identity would not.
 *
 * `authorId` does not change that; it adds the other half. The denormalised
 * columns say what a comment *looked like* when it was written and must never
 * be recomputed; the principal says *who* wrote it, so two humans' comments can
 * be told apart once a review is readable from more than one machine. Agent
 * rows have no principal and are not meant to: an agent session is a process,
 * not a person, and its identity is the MCP handshake it arrived on.
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
     * Which person wrote this, when a person did. NULL for every agent comment,
     * and for a human comment written before principals existed that has not
     * been backfilled yet (see `db/principals.ts`).
     *
     * No delete action, which in SQLite means the delete is *refused*: a
     * principal who has written comments cannot be removed out from under them.
     * That is the conservative reading of "a discussion outlives the code it
     * was about" and, unlike `set null` or `cascade`, it is what SQLite's
     * `ALTER TABLE ... ADD COLUMN` can actually express - anything else would
     * mean rebuilding the comments table to add one nullable column, and the
     * declaration here has to match the SQL that ships or the two quietly
     * disagree forever.
     */
    authorId: integer('author_id').references(() => principals.id),
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

/**
 * A file someone attached to a comment - in practice a screenshot.
 *
 * Content-addressed: the row is keyed by the sha256 of the bytes, and the file
 * on disk is `<dataDir>/attachments/<sha[0:2]>/<sha>.<ext>`. That makes ingest
 * naturally idempotent, which matters because the GUI and the MCP server are
 * separate processes writing the same database - pasting an image twice, or
 * two processes ingesting the same file at once, converges on one row and one
 * file rather than racing.
 *
 * This is app-owned data rather than something git owns, which is why it is
 * stored at all. The reason to copy the bytes instead of remembering a path is
 * the same reason `anchorSnapshot` above exists: a discussion has to outlive
 * the thing it is about. An agent writes a screenshot to /tmp and references
 * it; /tmp is purged next week; the comment still has to render. A pasted
 * clipboard image settles it outright - it has no path at all, only bytes.
 */
export const attachments = sqliteTable('attachments', {
  /** sha256 of the bytes, lowercase hex. Content-addressed: same bytes, same row. */
  sha: text('sha').primaryKey(),
  /** Determined by sniffing magic bytes, never from the supplied filename. */
  ext: text('ext').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  /** Nullable: dimensions are for layout and for telling an agent what it is about to read. */
  width: integer('width'),
  height: integer('height'),
  /** For display and for a sensible default alt text. */
  originalName: text('original_name'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type AttachmentRow = typeof attachments.$inferSelect
export type NewAttachmentRow = typeof attachments.$inferInsert

/**
 * "I have read this file" - one row per file a reviewer has ticked off.
 *
 * The tick is not a boolean. A file marked reviewed and then changed has to
 * lose its mark, or the list would quietly claim someone had read code that
 * did not exist when they looked. `contentDigest` is what makes that automatic:
 * it is a fingerprint of the diff as it was on screen at the moment of the
 * tick (see `shared/diff-digest.ts`), and the mark counts only while the file
 * still hashes to the same value. Rows are therefore left in place when a file
 * changes rather than deleted - re-reading the new version is one write, and a
 * mark that comes back if the change is reverted is the behaviour people
 * already expect from GitHub's "Viewed".
 *
 * Kept out of the reviews table, and out of localStorage: it is per review and
 * unbounded, and it is a real record of work done - the sort of thing that
 * should survive a machine, not a browser profile.
 */
export const reviewedFiles = sqliteTable(
  'reviewed_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** As everywhere else: the review going takes its marks with it. */
    reviewId: integer('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    /** Head-side path, the same key the diff and the file tree are keyed by. */
    filePath: text('file_path').notNull(),
    /** Fingerprint of the diff that was read. See the note above. */
    contentDigest: text('content_digest').notNull(),
    reviewedAt: text('reviewed_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [uniqueIndex('reviewed_files_path_idx').on(table.reviewId, table.filePath)]
)

export type ReviewedFileRow = typeof reviewedFiles.$inferSelect
export type NewReviewedFileRow = typeof reviewedFiles.$inferInsert
