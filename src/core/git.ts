/**
 * Live git inspection. Nothing in here is ever written to the database - git
 * state is read on demand every time it is displayed, because the working copy
 * can change (or vanish) without the app being involved.
 *
 * Shelling out to the user's own `git` rather than pulling in a git library:
 * it is the binary they already trust, it handles worktrees, submodules and
 * `.git` files correctly, and it keeps the dependency surface small.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath as realpathWithCallback } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { AppError } from '../shared/errors.js'
import type { RepositoryGitState } from '../shared/schemas.js'

const execFileAsync = promisify(execFile)

// `fs/promises` has no `realpath.native`; only the callback API exposes it, and
// the native variant is the one that reports true on-disk casing.
const realpathNative = promisify(realpathWithCallback.native)

/** Git should answer instantly on a local path; this only trips on a hung mount. */
const GIT_TIMEOUT_MS = 10_000

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      // Keep git from prompting for credentials or opening an editor; a blocked
      // child process would hang the IPC call forever.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown }
    if (err.code === 'ENOENT') {
      throw new AppError(
        'GIT_UNAVAILABLE',
        'Could not run `git`. Make sure git is installed and available on your PATH.'
      )
    }
    return {
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
      code: typeof err.code === 'number' ? err.code : 1
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve any path inside a repository to that repository's canonical root.
 *
 * This is what stops the same repo being tracked twice: `/work/app/src/lib` and
 * `/work/app` both come back as `/work/app`. `realpath` is used on the result so
 * symlinked paths - and, on macOS/Windows, paths typed with different casing -
 * also collapse to one canonical string that the UNIQUE index can rely on.
 */
export async function resolveRepositoryRoot(inputPath: string): Promise<string> {
  if (!(await isDirectory(inputPath))) {
    throw new AppError('PATH_NOT_FOUND', `No such folder: ${inputPath}`, {
      path: ['That folder does not exist.']
    })
  }

  const result = await runGit(['rev-parse', '--show-toplevel'], inputPath)
  if (result.code !== 0 || !result.stdout) {
    throw new AppError('NOT_A_GIT_REPOSITORY', `Not a git repository: ${inputPath}`, {
      path: ['This folder is not inside a git repository.']
    })
  }

  return canonicalise(result.stdout)
}

/**
 * `realpath.native` resolves symlinks *and* reports the true on-disk casing on
 * case-insensitive filesystems, which plain `realpath` does not.
 */
async function canonicalise(path: string): Promise<string> {
  try {
    return await realpathNative(path)
  } catch {
    return path
  }
}

/** The folder name of a repository root, used as the default display name. */
export function defaultNameForPath(repositoryRoot: string): string {
  return basename(repositoryRoot) || repositoryRoot
}

const UNREADABLE: RepositoryGitState = {
  exists: false,
  isGitRepository: false,
  branch: null,
  detachedAt: null,
  isEmpty: false,
  error: null
}

/**
 * Read the current git state of a stored path.
 *
 * Never throws for an ordinary "the repo moved" situation - a missing folder is
 * a state the UI renders, not an error that should blow up the whole list. Only
 * git being entirely absent propagates, since that affects every row equally.
 */
export async function readGitState(repositoryPath: string): Promise<RepositoryGitState> {
  if (!(await isDirectory(repositoryPath))) {
    return { ...UNREADABLE, error: 'Folder no longer exists.' }
  }

  const insideWorkTree = await runGit(['rev-parse', '--is-inside-work-tree'], repositoryPath)
  if (insideWorkTree.code !== 0 || insideWorkTree.stdout !== 'true') {
    return { ...UNREADABLE, exists: true, error: 'No longer a git repository.' }
  }

  // `symbolic-ref` reports the branch even in a repo with no commits yet, which
  // `rev-parse --abbrev-ref HEAD` cannot do.
  const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath)
  const hasCommits = (await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repositoryPath)).code === 0

  if (symbolic.code === 0 && symbolic.stdout) {
    return {
      exists: true,
      isGitRepository: true,
      branch: symbolic.stdout,
      detachedAt: null,
      isEmpty: !hasCommits,
      error: null
    }
  }

  const head = await runGit(['rev-parse', '--short', 'HEAD'], repositoryPath)
  return {
    exists: true,
    isGitRepository: true,
    branch: null,
    detachedAt: head.code === 0 && head.stdout ? head.stdout : null,
    isEmpty: !hasCommits,
    error: head.code === 0 ? null : 'Could not read HEAD.'
  }
}
