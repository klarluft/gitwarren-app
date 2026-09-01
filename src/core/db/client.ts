/**
 * SQLite connection, opened lazily and shared per process.
 *
 * The GUI and the MCP server are separate OS processes pointed at the same
 * file, which drives three of the pragmas below.
 */
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { ensureDataDirectory, getDatabasePath } from '../paths.js'
import { resolveMigrationsFolder } from './migrations.js'
import * as schema from './schema.js'

export type AppDatabase = BetterSQLite3Database<typeof schema>

let instance: AppDatabase | null = null
let connection: Database.Database | null = null

/**
 * Returns the shared connection, running any outstanding migrations the first
 * time it is called in this process. Migrating on open - rather than from a
 * separate startup step - means the MCP server is equally safe to start first.
 */
export function getDatabase(): AppDatabase {
  if (instance) return instance

  ensureDataDirectory()
  const sqlite = new Database(getDatabasePath())

  // WAL lets the GUI read while the MCP server writes, instead of the two
  // processes locking each other out.
  sqlite.pragma('journal_mode = WAL')
  // With two writers, one can find the file briefly locked. Wait rather than
  // failing instantly with SQLITE_BUSY.
  sqlite.pragma('busy_timeout = 5000')
  // NORMAL is the recommended durability level under WAL.
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: resolveMigrationsFolder() })

  connection = sqlite
  instance = db
  return instance
}

/** Closes the connection. Called on app quit; also used to reset between tests. */
export function closeDatabase(): void {
  connection?.close()
  connection = null
  instance = null
}
