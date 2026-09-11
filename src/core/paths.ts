/**
 * Filesystem locations for the app's own data.
 *
 * Deliberately free of any `electron` import: the MCP server runs in a separate
 * process and must land on exactly the same database file as the GUI. Both
 * processes call these functions rather than one using Electron's
 * `app.getPath('userData')` and the other guessing - that is how you end up
 * with two databases and a very confusing bug report.
 *
 * The layout mirrors what Electron would pick for `userData` on each platform.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const APP_DIR_NAME = 'GitWarren'
export const DATABASE_FILE_NAME = 'gitwarren.db'
/** Holds this install's instance id. See `core/instance.ts`. */
export const INSTANCE_FILE_NAME = 'instance-id'

/** Set to point the whole app at a throwaway directory. Used by the tests. */
export const DATA_DIR_ENV_VAR = 'GITWARREN_DATA_DIR'

export function getDataDirectory(): string {
  const override = process.env[DATA_DIR_ENV_VAR]?.trim()
  if (override) return override

  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_DIR_NAME)
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_DIR_NAME)
  }
}

export function getDatabasePath(): string {
  return join(getDataDirectory(), DATABASE_FILE_NAME)
}

/**
 * Where this install's instance id is kept. Next to the database rather than
 * inside it: the id names the install, and it has to be readable by a process
 * that has not opened - or cannot open - SQLite.
 */
export function getInstanceIdPath(): string {
  return join(getDataDirectory(), INSTANCE_FILE_NAME)
}

export function ensureDataDirectory(): string {
  const dir = getDataDirectory()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Where daemon tarballs downloaded for other machines are kept.
 *
 * In the data directory rather than beside the install, for the reason M4's
 * installer exists at all: the file is fetched *once* and then streamed to as
 * many hosts as share an architecture, so it has to outlive an app update. It
 * is also the half of the design that makes an air-gapped host work — the
 * machine with a browser does the downloading, and the host on the other end of
 * the pipe never talks to GitHub.
 *
 * Deliberately not swept on startup. A 45 MB file per architecture per version
 * is small next to what it saves on a slow link, and deleting one is
 * `rm -rf` in a directory the user can find; guessing when a version stops
 * being interesting is the kind of cleverness that deletes the file someone was
 * about to reinstall from.
 */
export const DAEMON_CACHE_DIR_NAME = 'daemon-cache'

export function getDaemonCacheDirectory(): string {
  return join(getDataDirectory(), DAEMON_CACHE_DIR_NAME)
}
