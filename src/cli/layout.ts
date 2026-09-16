/**
 * How this copy of GitWarren got onto the machine, and therefore what
 * `update` and `uninstall` are allowed to do to it.
 *
 * Until M3.3 nothing in the CLI needed to know: every command acted on the
 * data directory or on `~/.gitwarren/bin`, and both are the same wherever the
 * program itself lives. `update` and `uninstall` are the first two commands
 * whose *whole subject* is the install, and the first question either of them
 * has to answer is one this codebase had never asked - who owns these files?
 *
 * There are five answers, and only one of them means "ours":
 *
 *  - **`~/.gitwarren/daemon/<version>/`**, written by `packaging/install.sh` or
 *    by the app installing onto a host over ssh. Nothing else on the machine
 *    knows about it, there is no package manager to contradict, and the layout
 *    is versioned with a stable launcher in front of it - which is exactly the
 *    shape an in-place update needs. This is the only kind `update` replaces
 *    and the only kind `uninstall` deletes.
 *  - **Homebrew.** `brew` has a record of every file it poured and will
 *    happily tell the user that the formula is still installed after we delete
 *    its Cellar. Updating and removing are `brew upgrade` and `brew uninstall`,
 *    and the useful thing this command can do is say so.
 *  - **npm**, in someone's `node_modules`. Theirs to update, and a package
 *    manager is the thing that knows what else depends on it.
 *  - **npx**, out of the npm cache. There is nothing to update - the next run
 *    fetches - and nothing to uninstall that will not come back.
 *  - **A checkout**, under `tsx`. `install.ts` already refuses to write
 *    launchers for one, for the same reason: there is no file a login shell
 *    could run again, and nothing here should be deleting a git worktree.
 *
 * ## The rule, in one sentence
 *
 * A command may delete a file only if it can say which install put it there.
 * Everything below exists to make that sentence decidable, and every branch
 * that cannot decide it reports rather than acts.
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { getLauncherDirectory } from '../core/mcp-launcher.js'
import { locateSelfScript, locateMcpServer } from './install.js'

export type InstallKind = 'managed' | 'homebrew' | 'npm' | 'npx' | 'tarball' | 'checkout' | 'unknown'

export interface InstallLayout {
  kind: InstallKind
  /** The version this copy reports, which is what it is being compared against. */
  version: string
  /** `~/.gitwarren`, the directory the launchers and managed installs share. */
  home: string
  /** `~/.gitwarren/daemon`, where managed installs keep one directory each. */
  daemonRoot: string
  /** The root of this install's own files, or null when there is no such thing. */
  prefix: string | null
  /** The script this process was started from, or null under `tsx`. */
  script: string | null
  /** The MCP server bundle beside it, or null when this install ships none. */
  mcpServer: string | null
  /** True only for `managed`: `update` may replace these files itself. */
  selfUpdatable: boolean
  /** What to run instead, when something else owns the update. */
  updateWith: string | null
  /** What to run instead, when something else owns the files. */
  removeWith: string | null
  /** One line naming this install, for `doctor` and for the two commands' plans. */
  description: string
}

/**
 * `~/.gitwarren`, derived from the launcher directory rather than composed
 * again from `homedir()`.
 *
 * The two must agree - a managed install is *defined* as one whose files sit
 * beside the launchers that point at them - and the way to make two things
 * agree is to have one of them ask the other. `core/mcp-launcher.ts` has said
 * where `bin` is since M2 and is imported by the app as well, so it is the one
 * that gets to be right.
 */
export function getGitwarrenHome(): string {
  return dirname(getLauncherDirectory())
}

export function getDaemonRoot(): string {
  return join(getGitwarrenHome(), 'daemon')
}

/** Is `path` inside `directory`? Not "starts with the string": `/a/bc` is not in `/a/b`. */
export function isInside(path: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)
}

/** A tarball install is `bin/`, `lib/` and `drizzle/` under one directory. */
function looksLikeTarball(prefix: string): boolean {
  return (
    existsSync(join(prefix, 'lib')) &&
    (existsSync(join(prefix, 'bin', 'gitwarren')) || existsSync(join(prefix, 'bin', 'gitwarren.cmd')))
  )
}

/**
 * The version directories under `~/.gitwarren/daemon`, newest-looking last.
 *
 * Only directories that contain a launcher are counted. An interrupted install
 * leaves a `.install-<pid>` scratch directory behind - `install.sh` and the ssh
 * installer both unpack into one - and reporting that as an installed version
 * would be wrong in both directions: it is not runnable, and `update --prune`
 * should remove it without calling it a version.
 */
export interface DaemonDirectory {
  version: string
  path: string
  /** False for a scratch directory an interrupted install left behind. */
  runnable: boolean
}

export function listDaemonDirectories(daemonRoot = getDaemonRoot()): DaemonDirectory[] {
  let entries: string[]
  try {
    entries = readdirSync(daemonRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }

  return entries
    .map((version) => {
      const path = join(daemonRoot, version)
      return { version, path, runnable: looksLikeTarball(path) }
    })
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
}

/**
 * How many bytes a directory holds, for a sentence about what was freed.
 *
 * `du` would be shorter and is not on Windows. Symlinks are counted as their
 * own size rather than followed, so a link into the Cellar cannot make a
 * managed install look like it holds a package manager's worth of files.
 */
export function directorySize(path: string): number {
  let total = 0
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else {
        try {
          total += statSync(child, { throwIfNoEntry: false })?.size ?? 0
        } catch {
          // A file that vanished between the listing and the stat is zero.
        }
      }
    }
  }
  walk(path)
  return total
}

/** `128 MB`, for a person reading a plan rather than a byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Which of the five this is.
 *
 * Ordered most specific first, and every test is about the *path* rather than
 * about anything the environment claims. A `GITWARREN_*` variable or an argv
 * flag would be a thing to get wrong or to lie about; where the file is is
 * simply true, and `install.ts` has already resolved it through `realpathSync`
 * - which matters here more than anywhere, because Homebrew is reached through
 * a symlink in `bin` and would otherwise look like an unknown install at
 * `/opt/homebrew/bin`.
 */
function classify(script: string | null, daemonRoot: string): { kind: InstallKind; prefix: string | null } {
  if (script === null) return { kind: 'checkout', prefix: null }

  // `<pkg>/lib/gitwarren.cjs` for a tarball, `<pkg>/bin/gitwarren.mjs` for npm.
  // Both are two levels below the root, which is the only coincidence this
  // function relies on and the one `build-npm-package.mjs` is careful to keep.
  const prefix = dirname(dirname(script))

  if (isInside(script, daemonRoot)) return { kind: 'managed', prefix }

  const segments = script.split(/[\\/]/)
  if (segments.includes('Cellar')) return { kind: 'homebrew', prefix }
  // npm's own cache directory for `npx`, which is `_npx` on every platform.
  if (segments.includes('_npx')) return { kind: 'npx', prefix }
  if (segments.includes('node_modules')) return { kind: 'npm', prefix }
  if (looksLikeTarball(prefix)) return { kind: 'tarball', prefix }

  return { kind: 'unknown', prefix }
}

const ADVICE: Record<InstallKind, { update: string | null; remove: string | null; what: string }> = {
  managed: {
    update: null,
    remove: null,
    what: 'installed by install.sh or by GitWarren on another machine'
  },
  homebrew: {
    update: 'brew upgrade gitwarren-cli',
    remove: 'brew uninstall gitwarren-cli',
    what: 'poured by Homebrew'
  },
  npm: {
    update: 'npm install -g gitwarren@latest, or update it where it is depended on',
    remove: 'npm uninstall -g gitwarren, or remove it from the project that depends on it',
    what: 'installed by npm'
  },
  npx: {
    update: 'nothing - `npx gitwarren@latest` fetches the newest release every time',
    remove: 'nothing - this copy lives in the npm cache and `npm cache clean` clears it',
    what: 'run by npx out of the npm cache'
  },
  tarball: {
    update: 'unpack the new release tarball over it, or install.sh to move to ~/.gitwarren',
    remove: 'delete the directory it was unpacked into',
    what: 'a release tarball unpacked by hand'
  },
  checkout: {
    update: 'git pull && npm run build:daemon',
    remove: 'nothing - this is a source checkout',
    what: 'a source checkout running under tsx'
  },
  unknown: {
    update: 'reinstall it the way it was installed',
    remove: 'delete the directory it lives in',
    what: 'in a layout GitWarren does not recognise'
  }
}

/**
 * Everything the three commands need to know about this install, worked out
 * once so that their plans and their refusals cannot disagree.
 *
 * The two overrides are how the tests reach the four kinds this machine is
 * not. Every branch here turns on where a file is, and a test that could only
 * ever ask about the checkout it runs from would be a test of one case out of
 * five - so the answer to "where is this file" is a parameter, defaulted to
 * the true one.
 */
export function describeLayout(
  version: string,
  overrides: { script?: string | null; mcpServer?: string | null } = {}
): InstallLayout {
  const home = getGitwarrenHome()
  const daemonRoot = getDaemonRoot()
  const script = overrides.script === undefined ? locateSelfScript() : overrides.script
  const { kind, prefix } = classify(script, daemonRoot)
  const advice = ADVICE[kind]

  return {
    kind,
    version,
    home,
    daemonRoot,
    prefix,
    script,
    mcpServer: overrides.mcpServer === undefined ? locateMcpServer() : overrides.mcpServer,
    selfUpdatable: kind === 'managed',
    updateWith: advice.update,
    removeWith: advice.remove,
    description:
      prefix === null
        ? `GitWarren ${version}, ${advice.what}`
        : `GitWarren ${version} at ${prefix}, ${advice.what}`
  }
}
