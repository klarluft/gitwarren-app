/**
 * Where this `gitwarren` is, so it can write a file that outlives the process.
 *
 * `service install` and the two launchers under `~/.gitwarren/bin` all have the
 * same problem: they are files on disk that must start *this* install months
 * from now, from a login shell that has none of this process's environment.
 * They cannot ask again later, so the answer is worked out once, here, from
 * what the running process actually knows about itself.
 *
 * ## Why the answer is `execPath` and `argv[1]`, not a guess
 *
 * There are three ways this CLI legitimately starts, and no single path
 * expression covers them:
 *
 *  - **The tarball.** `bin/node lib/gitwarren.cjs`, unpacked wherever the user
 *    put it - `/opt`, `~/.local`, a Homebrew Cellar.
 *  - **npm.** The user's own Node running the bundle out of a `node_modules`,
 *    which npm may have hoisted anywhere.
 *  - **A checkout.** `tsx src/cli/gitwarren.ts`, which is how it is developed.
 *
 * The pair the OS used to start this process is correct in all three without
 * knowing which one happened. It is read through `realpathSync` because a
 * Homebrew install is reached through a symlink in `bin`, and a login item that
 * names the symlink breaks the day the version behind it changes.
 *
 * The third case is the one that must not be written down: `node` cannot run a
 * `.ts` file, so a login item built from a checkout would be a file that starts
 * nothing. `describeSelf` reports it as unwritable rather than producing one,
 * which is what `service install` refuses on.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MIGRATIONS_DIR_ENV_VAR, resolveMigrationsFolder } from '../core/db/migrations.js'
import { resolveWebRoot } from '../daemon/listen.js'
import { DATA_DIR_ENV_VAR } from '../core/paths.js'

/** The name `daemon/listen.ts` reads a web root override from. */
const WEB_ROOT_ENV_VAR = 'GITWARREN_WEB_ROOT'

/**
 * The environment a relaunch has to be handed back.
 *
 * ## Copying the variables is not enough, and this is where that was learned
 *
 * The first version of this carried whatever `GITWARREN_*` the process had been
 * given and no more, on the reasoning that only a *packaging* decision would
 * have set one. That is true, and it is beside the point: two of these have a
 * fallback that is relative to the **working directory**, and a login item does
 * not have one. launchd starts a job in `/`. So a launcher written from a
 * checkout - where nothing sets either variable, because walking up from the
 * repository root finds both - produced this, in a log file, at the next login:
 *
 *     Error: Could not find the drizzle migrations folder. Looked in:
 *       /drizzle
 *
 * Nothing was wrong with the launcher, the plist or the daemon. What was wrong
 * is that the *question* "where are the migrations" was left to be asked again
 * later, in a process that had lost the only context able to answer it.
 *
 * So both are resolved here, now, while the answer is still knowable, and
 * written into the launcher as absolute paths. That is what the tarball's `sh`
 * preamble has always done for its own layout; this is the same decision for
 * every other way of installing.
 *
 * `GITWARREN_DATA_DIR` is different and is only carried when it was set. It
 * names no part of the *install*, it is a choice about which database, and its
 * fallback is a per-platform absolute path that does not care where anything
 * was run from. It is carried at all for a reason that is easy to miss: someone
 * who has pointed one `gitwarren serve` at a scratch directory and then asks for
 * a login item means *that* directory, and an item that silently started
 * against their real database instead would be a surprise of the worst kind.
 */

export interface SelfDescription {
  /** The interpreter that is running this process. */
  node: string
  /**
   * The script it was given, or null when that script is not one `node` alone
   * could run again - a `.ts` file under tsx.
   */
  script: string | null
  /** The MCP server bundle next to it, or null when this install has none. */
  mcpServer: string | null
  /** The `GITWARREN_*` variables a relaunch needs. See `relaunchEnv`. */
  env: Record<string, string>
}

function relaunchEnv(): Record<string, string> {
  // Throws when there are none to find, which is the right moment to fail: a
  // launcher that cannot name the migrations is a login item that starts
  // nothing, and `resolveMigrationsFolder` already says where it looked.
  const env: Record<string, string> = { [MIGRATIONS_DIR_ENV_VAR]: resolveMigrationsFolder() }

  // Null is survivable in a way the migrations are not - a host that only ever
  // answers `--stdio` and the MCP server needs no renderer - so this is left
  // out rather than fatal, and `service install` says so.
  const webRoot = resolveWebRoot()
  if (webRoot) env[WEB_ROOT_ENV_VAR] = webRoot

  const dataDir = process.env[DATA_DIR_ENV_VAR]?.trim()
  if (dataDir) env[DATA_DIR_ENV_VAR] = dataDir

  return env
}

/**
 * The MCP server that belongs to this install.
 *
 * A sibling of the CLI bundle first: `lib/gitwarren.cjs` and `lib/server.cjs`
 * sit next to each other in the tarball. Then `../lib` from where the script
 * is, which is the npm package - there the entry point is a six-line `bin`
 * shim in ESM and the bundles are one directory over, because npm wants a
 * `bin` and Node wants a `require`. Then `out/mcp/server.cjs` under the working
 * directory, which is the checkout.
 *
 * Null rather than a path that is not there: `service install` writes an agent
 * launcher out of this, and a launcher pointing at a missing file is worse than
 * no launcher, because the Agent Access page would report it as available.
 */
function findMcpServer(script: string | null): string | null {
  const candidates = [
    script && join(dirname(script), 'server.cjs'),
    script && join(dirname(script), '..', 'lib', 'server.cjs'),
    join(process.cwd(), 'out', 'mcp', 'server.cjs')
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return realpathSync(candidate)
  }
  return null
}

/** What this process would have to be told to start itself again. */
export function describeSelf(): SelfDescription {
  const argv1 = process.argv[1]
  let script: string | null = null

  if (argv1 !== undefined) {
    try {
      const resolved = realpathSync(argv1)
      // TypeScript is not something `node` runs. See the header.
      script = /\.[cm]?ts$/i.test(resolved) ? null : resolved
    } catch {
      script = null
    }
  }

  return { node: realpathSync(process.execPath), script, mcpServer: findMcpServer(script), env: relaunchEnv() }
}
