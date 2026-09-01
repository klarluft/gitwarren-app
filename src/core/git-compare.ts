/**
 * Comparing two points in a repository - the git half of a review.
 *
 * The idea that shapes this whole module: **a branch's real state is not always
 * a commit.** GitWarren exists to review work in progress, and work in progress
 * usually sits uncommitted in a worktree. So every read here starts by asking
 * `git worktree list` where the head branch is actually checked out, and reads
 * the uncommitted state from *that* directory - which is frequently not the
 * repository path the user originally added.
 *
 * Diffs are three-dot (merge-base) like a pull request: `base...head` shows what
 * head added since the branches diverged, not the unrelated commits base picked
 * up meanwhile. Concretely that means `git diff <merge-base>`, which - run
 * inside the head's worktree, with no second endpoint - compares the merge base
 * against the *working tree*, folding staged and unstaged edits into the same
 * patch. Untracked files are then synthesised on top (see `diff-parser.ts`),
 * because staging them into a scratch index would mean writing to a repository
 * this app promises only to read.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalise, isDirectory, runGit, runGitRaw } from './git-exec.js'
import { buildUntrackedFileDiff, parseUnifiedDiff } from './diff-parser.js'
import type {
  CompareEndpoint,
  FileDiff,
  GitCommit,
  GitRef,
  GitWorktree,
  RepositoryRefs,
  ReviewCommits,
  ReviewCompare,
  ReviewDiff,
  WorkingTreeChanges,
  WorkingTreeFile
} from '../shared/git.js'

/** Field separator inside a single `for-each-ref` / `log` record. */
const FIELD = '\u0000'
/** Record separator between commits, so subjects and bodies stay intact. */
const RECORD = '\u001e'

/** A long-lived branch compared against an old tag can be tens of thousands of
 *  commits; nobody scrolls that, and it would all cross IPC. */
const MAX_COMMITS = 500

/** Above this an untracked file is listed but not rendered. */
const MAX_UNTRACKED_BYTES = 512 * 1024

/** Names tried, in order, when guessing a repository's trunk. */
const TRUNK_CANDIDATES = ['main', 'master', 'trunk', 'develop', 'development']

function shortenSha(sha: string): string {
  return sha.slice(0, 8)
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

/**
 * Every working tree attached to this repository, main checkout included.
 *
 * `git worktree list` answers the same for all of them, so it does not matter
 * whether the tracked path is the main checkout or a linked worktree - which is
 * good, because the user is allowed to add either.
 */
export async function listWorktrees(repositoryPath: string): Promise<GitWorktree[]> {
  const result = await runGit(['worktree', 'list', '--porcelain'], repositoryPath)
  if (result.code !== 0) return []

  const tracked = await canonicalise(repositoryPath)
  const worktrees: GitWorktree[] = []
  let current: Partial<GitWorktree> | null = null

  const flush = (): void => {
    if (current?.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        isMain: worktrees.length === 0,
        isBare: current.isBare ?? false,
        isDetached: current.isDetached ?? false,
        isLocked: current.isLocked ?? false,
        isTracked: false
      })
    }
    current = null
  }

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'detached') current.isDetached = true
    else if (line === 'bare') current.isBare = true
    else if (line === 'locked' || line.startsWith('locked ')) current.isLocked = true
  }
  flush()

  // The porcelain paths are what git recorded, which may differ in symlinks or
  // casing from the canonical path stored for the repository. Canonicalise both
  // sides before deciding which worktree is "the tracked one".
  return Promise.all(
    worktrees.map(async (worktree) => ({
      ...worktree,
      isTracked: (await canonicalise(worktree.path)) === tracked
    }))
  )
}

// ---------------------------------------------------------------------------
// Uncommitted state
// ---------------------------------------------------------------------------

const EMPTY_WORKING_TREE: Omit<WorkingTreeChanges, 'worktreePath' | 'branch'> = {
  isDirty: false,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  paths: [],
  files: []
}

/**
 * Read one worktree's uncommitted state.
 *
 * `--no-renames` on purpose: rename detection makes `-z` records carry two
 * paths, and nothing here benefits from knowing a rename was a rename. An
 * add/delete pair counts the same and parses unambiguously.
 */
export async function readWorkingTreeChanges(
  worktreePath: string,
  knownBranch?: string | null
): Promise<WorkingTreeChanges> {
  const branch =
    knownBranch !== undefined
      ? knownBranch
      : await (async () => {
          const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath)
          return symbolic.code === 0 && symbolic.stdout ? symbolic.stdout : null
        })()

  const result = await runGitRaw(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    worktreePath
  )
  if (result.code !== 0) return { worktreePath, branch, ...EMPTY_WORKING_TREE }

  const files: WorkingTreeFile[] = []
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0

  for (const entry of result.stdout.split('\0')) {
    if (entry.length < 4) continue
    // `XY <path>`: two status codes, a space, then the path.
    const index = entry.charAt(0)
    const worktreeCode = entry.charAt(1)
    const path = entry.slice(3)

    const isUntracked = index === '?' && worktreeCode === '?'
    const isConflicted =
      index === 'U' || worktreeCode === 'U' || (index === 'A' && worktreeCode === 'A') || (index === 'D' && worktreeCode === 'D')

    if (isUntracked) untracked += 1
    else {
      if (index !== ' ') staged += 1
      if (worktreeCode !== ' ') unstaged += 1
    }
    if (isConflicted) conflicted += 1

    files.push({ path, index, worktree: worktreeCode, isUntracked, isConflicted })
  }

  return {
    worktreePath,
    branch,
    isDirty: files.length > 0,
    staged,
    unstaged,
    untracked,
    conflicted,
    paths: files.map((file) => file.path),
    files
  }
}

// ---------------------------------------------------------------------------
// Refs, for the review-creation pickers
// ---------------------------------------------------------------------------

/**
 * Every ref worth offering as an endpoint, annotated with where - if anywhere -
 * it is currently checked out and whether that worktree is dirty. The picker
 * uses that to tell the user, before they create the review, that a branch has
 * uncommitted work waiting to be looked at.
 */
export async function readRepositoryRefs(repositoryPath: string): Promise<RepositoryRefs> {
  if (!(await isDirectory(repositoryPath))) {
    return {
      refs: [],
      worktrees: [],
      currentBranch: null,
      defaultBranch: null,
      error: 'Folder no longer exists.'
    }
  }

  const worktrees = await listWorktrees(repositoryPath)

  const format = [
    '%(refname)',
    '%(refname:short)',
    '%(objectname)',
    '%(creatordate:iso-strict)',
    '%(contents:subject)'
  ].join('%00')

  const result = await runGitRaw(
    [
      'for-each-ref',
      '--sort=-creatordate',
      `--format=${format}`,
      'refs/heads',
      'refs/remotes',
      'refs/tags'
    ],
    repositoryPath
  )

  if (result.code !== 0) {
    return {
      refs: [],
      worktrees,
      currentBranch: worktrees.find((worktree) => worktree.isTracked)?.branch ?? null,
      defaultBranch: null,
      error: result.stderr || 'Could not read the repository refs.'
    }
  }

  // Dirty state is per worktree, not per ref, so read each worktree once.
  const dirtyByWorktree = new Map<string, boolean>()
  await Promise.all(
    worktrees
      .filter((worktree) => !worktree.isBare)
      .map(async (worktree) => {
        const changes = await readWorkingTreeChanges(worktree.path, worktree.branch)
        dirtyByWorktree.set(worktree.path, changes.isDirty)
      })
  )
  const worktreeByBranch = new Map(
    worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch as string, worktree])
  )

  const refs: GitRef[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const [fullName, name, sha, createdAt, subject] = line.split(FIELD)
    if (!fullName || !name || !sha) continue
    // `refs/remotes/origin/HEAD` is a pointer at another ref already in the list.
    if (fullName.endsWith('/HEAD')) continue

    const kind = fullName.startsWith('refs/heads/')
      ? 'local-branch'
      : fullName.startsWith('refs/remotes/')
        ? 'remote-branch'
        : 'tag'

    const worktree = kind === 'local-branch' ? worktreeByBranch.get(name) : undefined

    refs.push({
      name,
      fullName,
      kind,
      sha,
      shortSha: shortenSha(sha),
      committedAt: createdAt || null,
      subject: subject || null,
      checkedOutAt: worktree?.path ?? null,
      hasUncommittedChanges: worktree ? (dirtyByWorktree.get(worktree.path) ?? false) : false
    })
  }

  return {
    refs,
    worktrees,
    currentBranch: worktrees.find((worktree) => worktree.isTracked)?.branch ?? null,
    defaultBranch: await guessDefaultBranch(repositoryPath, refs),
    error: null
  }
}

async function guessDefaultBranch(repositoryPath: string, refs: GitRef[]): Promise<string | null> {
  const localNames = new Set(refs.filter((ref) => ref.kind === 'local-branch').map((ref) => ref.name))

  // What the remote itself calls its default, when the clone recorded it.
  const remoteHead = await runGit(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    repositoryPath
  )
  if (remoteHead.code === 0 && remoteHead.stdout) {
    const name = remoteHead.stdout.replace(/^origin\//, '')
    if (localNames.has(name)) return name
  }

  const candidate = TRUNK_CANDIDATES.find((name) => localNames.has(name))
  if (candidate) return candidate

  return refs.find((ref) => ref.kind === 'local-branch')?.name ?? null
}

// ---------------------------------------------------------------------------
// Resolving a review's two endpoints
// ---------------------------------------------------------------------------

async function resolveEndpoint(repositoryPath: string, ref: string): Promise<CompareEndpoint> {
  // `^{commit}` makes an annotated tag resolve to the commit it points at, and
  // rejects refs that name a tree or a blob.
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repositoryPath)
  if (result.code !== 0 || !result.stdout) {
    // Phrased to read correctly both when creating a review against a typo and
    // when opening one whose branch has since been deleted.
    return { ref, sha: null, shortSha: null, error: `\`${ref}\` does not resolve to a commit.` }
  }
  return { ref, sha: result.stdout, shortSha: shortenSha(result.stdout), error: null }
}

/**
 * Work out, for a base and head ref, what they point at right now, where the
 * merge base is, and which worktree - if any - holds uncommitted head work.
 */
export async function resolveCompare(
  repositoryPath: string,
  baseRef: string,
  headRef: string
): Promise<ReviewCompare> {
  const missing: ReviewCompare = {
    base: { ref: baseRef, sha: null, shortSha: null, error: null },
    head: { ref: headRef, sha: null, shortSha: null, error: null },
    mergeBase: null,
    headWorktree: null,
    workingTree: null,
    error: 'Folder no longer exists.'
  }
  if (!(await isDirectory(repositoryPath))) return missing

  const [base, head, worktrees] = await Promise.all([
    resolveEndpoint(repositoryPath, baseRef),
    resolveEndpoint(repositoryPath, headRef),
    listWorktrees(repositoryPath)
  ])

  const headBranch = headRef.replace(/^refs\/heads\//, '')
  const headWorktree =
    worktrees.find((worktree) => worktree.branch !== null && worktree.branch === headBranch) ??
    // A worktree sitting detached exactly on the head commit is reviewing the
    // same state, so its uncommitted work is still the head's uncommitted work.
    worktrees.find(
      (worktree) => head.sha !== null && worktree.isDetached && worktree.head === head.sha
    ) ??
    null

  const workingTree =
    headWorktree && !headWorktree.isBare
      ? await readWorkingTreeChanges(headWorktree.path, headWorktree.branch)
      : null

  if (base.error || head.error) {
    return {
      base,
      head,
      mergeBase: null,
      headWorktree,
      workingTree,
      error: base.error ?? head.error
    }
  }

  const mergeBase = await runGit(['merge-base', base.sha as string, head.sha as string], repositoryPath)
  if (mergeBase.code !== 0 || !mergeBase.stdout) {
    return {
      base,
      head,
      mergeBase: null,
      headWorktree,
      workingTree,
      error: 'These two refs have no common ancestor, so there is nothing to compare.'
    }
  }

  return { base, head, mergeBase: mergeBase.stdout, headWorktree, workingTree, error: null }
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/**
 * The commits on head that base does not have - `git log base..head`, which is
 * the same set as `merge-base..head` and matches the three-dot diff.
 */
export async function readReviewCommits(
  repositoryPath: string,
  baseRef: string,
  headRef: string
): Promise<ReviewCommits> {
  const compare = await resolveCompare(repositoryPath, baseRef, headRef)
  if (compare.error || !compare.base.sha || !compare.head.sha) {
    return { ...compare, commits: [], truncated: false }
  }

  // `%x00` / `%x1e` rather than the constants themselves: git expands these,
  // whereas a literal NUL in the argument would terminate it early.
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%cI', '%s', '%b'].join('%x00') + '%x1e'
  const result = await runGitRaw(
    [
      'log',
      `--max-count=${MAX_COMMITS + 1}`,
      '--no-color',
      `--format=${format}`,
      `${compare.base.sha}..${compare.head.sha}`
    ],
    repositoryPath
  )

  if (result.code !== 0) {
    return {
      ...compare,
      commits: [],
      truncated: false,
      error: result.stderr || 'Could not read the commit list.'
    }
  }

  const commits: GitCommit[] = []
  for (const record of result.stdout.split(RECORD)) {
    const trimmed = record.replace(/^\n/, '')
    if (!trimmed.trim()) continue
    const [sha, shortSha, authorName, authorEmail, authoredAt, committedAt, subject, body] =
      trimmed.split(FIELD)
    if (!sha) continue
    commits.push({
      sha,
      shortSha: shortSha ?? shortenSha(sha),
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      authoredAt: authoredAt ?? '',
      committedAt: committedAt ?? '',
      subject: subject ?? '',
      body: (body ?? '').trim()
    })
  }

  return {
    ...compare,
    commits: commits.slice(0, MAX_COMMITS),
    truncated: commits.length > MAX_COMMITS
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface ReadDiffOptions {
  /**
   * Fold the head worktree's uncommitted work into the patch. Ignored when no
   * worktree has the head branch checked out - there is nothing to fold in.
   */
  includeUncommitted: boolean
}

export async function readReviewDiff(
  repositoryPath: string,
  baseRef: string,
  headRef: string,
  options: ReadDiffOptions
): Promise<ReviewDiff> {
  const compare = await resolveCompare(repositoryPath, baseRef, headRef)
  const empty = { files: [], additions: 0, deletions: 0, includedUncommitted: false, truncated: false }
  if (compare.error || !compare.mergeBase || !compare.head.sha) return { ...compare, ...empty }

  const includeUncommitted =
    options.includeUncommitted && compare.headWorktree !== null && compare.workingTree !== null

  // Inside the head's worktree, `git diff <merge-base>` with no second endpoint
  // compares against the working tree, so committed and uncommitted changes
  // arrive as one patch. With an explicit second endpoint it stays committed-only.
  const cwd = includeUncommitted ? (compare.headWorktree as { path: string }).path : repositoryPath
  const range = includeUncommitted ? [compare.mergeBase] : [compare.mergeBase, compare.head.sha]

  const result = await runGitRaw(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--unified=3',
      ...range,
      '--'
    ],
    cwd
  )

  if (result.code !== 0) {
    return { ...compare, ...empty, error: result.stderr || 'Could not read the diff.' }
  }

  const files = parseUnifiedDiff(result.stdout)

  if (includeUncommitted) {
    files.push(...(await readUntrackedFiles(cwd)))
  }

  // Badge the files whose change is not (entirely) committed anywhere yet.
  const dirtyPaths = new Set(compare.workingTree?.paths ?? [])
  for (const file of files) {
    if (!includeUncommitted) continue
    if (file.isUntracked || dirtyPaths.has(file.path) || (file.oldPath !== null && dirtyPaths.has(file.oldPath))) {
      file.hasUncommittedChanges = true
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path))

  return {
    ...compare,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    includedUncommitted: includeUncommitted,
    truncated: files.some((file) => file.truncated)
  }
}

/**
 * Untracked files, rendered as whole-file additions.
 *
 * `--exclude-standard` applies .gitignore and friends, so build output and
 * `node_modules` stay out of the review the same way they stay out of a commit.
 */
async function readUntrackedFiles(worktreePath: string): Promise<FileDiff[]> {
  const listed = await runGitRaw(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath)
  if (listed.code !== 0) return []

  const paths = listed.stdout.split('\0').filter((path) => path.length > 0)

  return Promise.all(
    paths.map(async (path) => {
      const absolute = join(worktreePath, path)
      try {
        const info = await stat(absolute)
        if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) {
          return buildUntrackedFileDiff(path, '', { isBinary: true })
        }
        const buffer = await readFile(absolute)
        // Git's own heuristic: a NUL byte near the start means "not text".
        const isBinary = buffer.subarray(0, 8000).includes(0)
        return buildUntrackedFileDiff(path, isBinary ? '' : buffer.toString('utf8'), { isBinary })
      } catch {
        // Raced with a delete, or unreadable. Listing it is still the truth.
        return buildUntrackedFileDiff(path, '', { isBinary: true })
      }
    })
  )
}
