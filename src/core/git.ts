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
  rootCommit: null,
  error: null
}

/**
 * Root commits already read, by repository path.
 *
 * The only thing in this module that is remembered between calls, and it is
 * remembered because it is the only thing here that is not *live*. Every other
 * field is read fresh precisely because it changes while the app is open;
 * where a history begins does not. What makes the cache worth having is the
 * cost: `rev-list` walks the first-parent chain to the beginning of time, which
 * for a repository with a hundred thousand commits is not something to do on
 * every render of a list.
 *
 * It is allowed to be wrong in exactly one way - somebody rewrites the root
 * commit of a repository while GitWarren is running, and the grouping is stale
 * until the next launch. That is a rebase of the first commit of a project,
 * which is rarer than the app being restarted.
 *
 * Keyed by path rather than by repository id because the answer belongs to the
 * checkout, and two rows pointing at one path have the same one.
 */
const rootCommits = new Map<string, string | null>()

/**
 * The commit a history starts at, or null when there is not one yet.
 *
 * `--first-parent` is what makes this a single answer. An ordinary
 * `rev-list --max-parents=0` reports *every* root, and a repository that has
 * ever absorbed another one by merge has more than one - so the set is not a
 * key, while the root of the first-parent chain is: it is where the project
 * itself began, and it is the same commit in every clone of it.
 */
async function readRootCommit(repositoryPath: string): Promise<string | null> {
  const cached = rootCommits.get(repositoryPath)
  if (cached !== undefined) return cached

  const result = await runGit(
    ['rev-list', '--max-parents=0', '--first-parent', 'HEAD'],
    repositoryPath
  )
  // The last line, not the first: `rev-list` answers newest first, so on the
  // rare history where the filter still leaves two, the oldest is the root.
  const root =
    result.code === 0 && result.stdout ? (result.stdout.split('\n').at(-1)?.trim() ?? null) : null

  const value = root && root.length > 0 ? root : null
  rootCommits.set(repositoryPath, value)
  return value
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

  // Skipped entirely on a repository with no commits: there is no root to find,
  // and `rev-list HEAD` on an unborn branch is an error rather than an answer.
  const rootCommit = hasCommits ? await readRootCommit(repositoryPath) : null

  if (symbolic.code === 0 && symbolic.stdout) {
    return {
      exists: true,
      isGitRepository: true,
      branch: symbolic.stdout,
      detachedAt: null,
      isEmpty: !hasCommits,
      rootCommit,
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
    rootCommit,
    error: head.code === 0 ? null : 'Could not read HEAD.'
  }
}
