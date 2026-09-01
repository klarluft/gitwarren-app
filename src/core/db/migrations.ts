/**
 * Locating the generated migration folder at runtime.
 *
 * This is the part that quietly breaks in a packaged app: in dev the `drizzle`
 * folder sits at the repo root, but once packaged the source lives inside
 * `app.asar` while the migrations are copied to the app's resources directory
 * (see `extraResources` in electron-builder.yml). Both the GUI process and the
 * MCP process use this resolver, so they always agree on which migrations to
 * apply to the database file they share.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Escape hatch for tests and for unusual packaging layouts. */
export const MIGRATIONS_DIR_ENV_VAR = 'GITWARREN_MIGRATIONS_DIR'

/** A real drizzle output folder always has a journal; a stray `drizzle/` won't. */
function isMigrationsFolder(candidate: string): boolean {
  return existsSync(join(candidate, 'meta', '_journal.json'))
}

export function resolveMigrationsFolder(): string {
  const override = process.env[MIGRATIONS_DIR_ENV_VAR]?.trim()
  if (override) {
    if (!isMigrationsFolder(override)) {
      throw new Error(
        `${MIGRATIONS_DIR_ENV_VAR} does not point at a drizzle migrations folder: ${override}`
      )
    }
    return override
  }

  const candidates: string[] = []

  // Packaged: electron-builder copies ./drizzle into the resources directory.
  // `resourcesPath` exists in the main process and in any process started with
  // ELECTRON_RUN_AS_NODE, which is how the MCP server is launched. In dev it
  // points into Electron's own bundle, where the journal check below fails and
  // we simply fall through to the source-tree candidates.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'drizzle'))

  // Dev / unpackaged: both `electron-vite dev` and the MCP dev script are
  // launched from the project root, so walk up from the working directory.
  let dir = resolve(process.cwd())
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(dir, 'drizzle'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const found = candidates.find(isMigrationsFolder)
  if (!found) {
    throw new Error(
      `Could not find the drizzle migrations folder. Looked in:\n  ${candidates.join('\n  ')}\n` +
        `Set ${MIGRATIONS_DIR_ENV_VAR} to override.`
    )
  }
  return found
}
