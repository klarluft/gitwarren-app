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

export function ensureDataDirectory(): string {
  const dir = getDataDirectory()
  mkdirSync(dir, { recursive: true })
  return dir
}
