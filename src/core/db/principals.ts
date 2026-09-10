/**
 * The local principal, and the one-time repair of the rows that predate it.
 *
 * Why this is not in the migration SQL: the local principal is identified by
 * this install's instance id, which lives in a file in the data directory and
 * is generated the first time anything asks for it. drizzle-kit writes its SQL
 * at build time on a developer's machine and has no idea what that value will
 * be. So the schema change ships as a migration and the *data* step runs here,
 * on open, right after the migrations have been applied.
 *
 * Everything below therefore has to be safe to run on every open, in either
 * process, in any order. It is idempotent twice over: the insert leans on the
 * unique index over (kind, identifier) rather than on having looked first, and
 * the backfill is guarded by a read that finds nothing on all but the very
 * first open after the upgrade.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { comments, principals, type PrincipalRow } from './schema.js'
import { getInstanceId } from '../instance.js'
import { HUMAN_NAME } from '../../shared/actors.js'
import type { AppDatabase } from './client.js'

/** The authority behind "the person who owns this install". */
export const LOCAL_PRINCIPAL_KIND = 'local' as const

/**
 * Resolved once per process by `ensureLocalPrincipal`, which the database
 * client calls while opening. Cleared by `closeDatabase`, so a test that
 * switches data directories does not carry the previous install's principal
 * into the next one.
 */
let cached: PrincipalRow | null = null

/**
 * Seed the local principal and adopt the comments that were written before it
 * existed.
 *
 * Takes the database as an argument rather than calling `getDatabase()`: this
 * runs *during* the open, and reaching back into the client for a connection
 * that has not been published yet would recurse.
 */
export function ensureLocalPrincipal(db: AppDatabase): PrincipalRow {
  const identifier = getInstanceId()

  const find = (): PrincipalRow | undefined =>
    db
      .select()
      .from(principals)
      .where(and(eq(principals.kind, LOCAL_PRINCIPAL_KIND), eq(principals.identifier, identifier)))
      .get()

  // Read first, so that every open after the first one is a single indexed
  // lookup. This runs on the startup path of both processes, and taking a write
  // transaction each time to insert a row that is already there would put them
  // in each other's way for no reason at all.
  let row = find()

  if (!row) {
    // `do nothing` rather than trusting the read above: on first launch the GUI
    // and an agent's MCP server routinely open the database within milliseconds
    // of each other, both find nothing, and both insert. The unique index over
    // (kind, identifier) is the only thing that can arbitrate that correctly.
    db.insert(principals)
      .values({ kind: LOCAL_PRINCIPAL_KIND, identifier, displayName: HUMAN_NAME })
      .onConflictDoNothing()
      .run()
    row = find()
  }

  // The row was either found or just written, so this is only reachable if
  // something removed it in between. Nothing does, and a database whose
  // principal vanished mid-open is not something to paper over.
  if (!row) throw new Error('The local principal could not be created.')

  adoptExistingHumanComments(db, row.id)

  cached = row
  return row
}

/**
 * Point every human comment that has no principal at this install's.
 *
 * The claim being made is narrow and worth stating: on a machine that has been
 * running GitWarren, the person who typed those comments is the person who owns
 * this install, because a comment written from the app has never had any other
 * possible author. That is what makes the backfill safe rather than a guess.
 *
 * Agent rows are deliberately untouched. Their identity is the MCP handshake
 * they arrived on - a tool and a session, not a person - and inventing a
 * principal for a process that has long since exited would make the column mean
 * two different things.
 */
function adoptExistingHumanComments(db: AppDatabase, principalId: number): void {
  // The guard exists so the common case - every open after the first - is a
  // single indexed read rather than a write transaction over the whole table.
  const orphan = db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.authorKind, 'human'), isNull(comments.authorId)))
    .limit(1)
    .get()
  if (!orphan) return

  db.update(comments)
    .set({ authorId: principalId })
    .where(and(eq(comments.authorKind, 'human'), isNull(comments.authorId)))
    .run()
}

/**
 * The principal to stamp on anything the person at this keyboard writes.
 *
 * Cheap enough to call per comment: it is a cached row, resolved while the
 * database was being opened.
 */
export function getLocalPrincipal(): PrincipalRow {
  if (cached) return cached
  // Unreachable through any normal path: every write goes through a service,
  // and every service reaches the database through `getDatabase()`, which
  // resolves this before it hands the connection out. Loud rather than lazily
  // re-resolving, because a silent second resolution would mean the open did
  // not happen and something else is wrong.
  throw new Error('The database has not been opened, so there is no local principal yet.')
}

/** Called by `closeDatabase`. See the note on `cached`. */
export function resetLocalPrincipalCache(): void {
  cached = null
}
