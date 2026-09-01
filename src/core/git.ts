/**
 * Live git inspection of a tracked repository.
 *
 * Nothing in here is ever written to the database - git state is read on demand
 * every time it is displayed, because the working copy can change (or vanish)
 * without the app being involved. The comparison side of git (worktrees,
 * commits, diffs) lives in `git-compare.ts`; both share one process runner in
 * `git-exec.ts`.
 */
import { basename } from 'node:path'
import { AppError } from '../shared/errors.js'
import { canonicalise, isDirectory, runGit } from './git-exec.js'
import type { RepositoryGitState } from '../shared/schemas.js'

/**
 * Resolve any path inside a repository to that repository's canonical root.
 *
 * This is what stops the same repo being tracked twice: `/work/app/src/lib` and
 * `/work/app` both come back as `/work/app`. `realpath` is used on the result so
 * symlinked paths - and, on macOS/Windows, paths typed with different casing -
 * also collapse to one canonical string that the UNIQUE index can rely on.
 *
 * Note that a linked worktree is its own toplevel, so adding one tracks that
 * worktree rather than the main checkout. That is fine: everything downstream
 * enumerates worktrees from whichever one it was given (see `git-compare.ts`).
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
