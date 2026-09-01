/**
 * Read-only git shapes shared by the core, the IPC layer and the UI.
 *
 * These are plain TypeScript types rather than zod schemas, unlike everything
 * in `schemas.ts`. The rule that decides which file a shape belongs in: zod is
 * for values that cross a *trust* boundary - anything a caller supplies and the
 * service must not believe. Nothing here is ever supplied by a caller. It is
 * produced by reading git, flows one way out to the UI, and is never written
 * back or stored, so a runtime schema would be ceremony with no payoff.
 */

/** One entry from `git worktree list` - the main checkout or a linked worktree. */
export interface GitWorktree {
  /** Absolute path to the working directory. */
  path: string
  /** Commit currently checked out there, or null in a bare/empty worktree. */
  head: string | null
  /** Short branch name, or null when the worktree is detached or bare. */
  branch: string | null
  /** True for the main checkout, false for a linked worktree. */
  isMain: boolean
  isBare: boolean
  isDetached: boolean
  isLocked: boolean
  /** True when this is the worktree the tracked repository path points at. */
  isTracked: boolean
}

export type GitRefKind = 'local-branch' | 'remote-branch' | 'tag'

export interface GitRef {
  /** Short display name: `main`, `origin/main`, `v1.2.0`. */
  name: string
  /** Full ref name, unambiguous when a branch and a tag share a short name. */
  fullName: string
  kind: GitRefKind
  sha: string
  shortSha: string
  /** ISO-8601. Used to sort the picker so recent work is at the top. */
  committedAt: string | null
  subject: string | null
  /** Path of the worktree with this branch checked out, when there is one. */
  checkedOutAt: string | null
  /** True when that worktree currently has uncommitted changes. */
  hasUncommittedChanges: boolean
}

export interface RepositoryRefs {
  refs: GitRef[]
  worktrees: GitWorktree[]
  /** Branch checked out in the tracked worktree - the natural default head. */
  currentBranch: string | null
  /**
   * Best guess at the repository's trunk (`main`, `master`, ...), used to
   * pre-fill the base. Null when none of the usual candidates exist.
   */
  defaultBranch: string | null
  error: string | null
}

export interface GitCommit {
  sha: string
  shortSha: string
  authorName: string
  authorEmail: string
  authoredAt: string
  committedAt: string
  subject: string
  body: string
}

/** A single path reported by `git status`, with its index/worktree codes. */
export interface WorkingTreeFile {
  path: string
  /** Staged status code, or ' ' when unchanged in the index. */
  index: string
  /** Unstaged status code, or ' ' when unchanged in the working tree. */
  worktree: string
  isUntracked: boolean
  isConflicted: boolean
}

/**
 * The uncommitted state of one worktree. This is the piece that lets GitWarren
 * review work that has not been committed anywhere yet.
 */
export interface WorkingTreeChanges {
  /**
   * Which directory on disk this was read from. Worth showing: it is often not
   * the repository path the user originally added.
   */
  worktreePath: string
  branch: string | null
  isDirty: boolean
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /** Every path with any uncommitted modification, for badging files. */
  paths: string[]
  files: WorkingTreeFile[]
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed'

export type DiffLineType = 'context' | 'insert' | 'delete'

export interface DiffLine {
  type: DiffLineType
  content: string
  /** Line number on the base side, null for inserted lines. */
  oldNumber: number | null
  /** Line number on the head side, null for deleted lines. */
  newNumber: number | null
}

export interface DiffHunk {
  /** The literal `@@ ... @@` line, including any trailing section heading. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  /** Path on the head side; for a deletion, the path it had on the base side. */
  path: string
  /** Previous path, set only for renames and copies. */
  oldPath: string | null
  status: FileChangeStatus
  isBinary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** True when the patch was too large to render in full. */
  truncated: boolean
  /** True when this file is untracked - it exists only in the working tree. */
  isUntracked: boolean
  /** True when part of this file's change is not committed anywhere. */
  hasUncommittedChanges: boolean
}

/**
 * One file's head-side text, read whole so the UI can show the context a
 * three-line unified diff leaves out. See `readReviewFile` for why the whole
 * file crosses at once rather than a range per expander.
 */
export interface FileContent {
  path: string
  /** Where the text came from - the worktree on disk, or a committed blob. */
  source: 'worktree' | 'commit'
  lines: string[]
  /** Lines past the ceiling were dropped; the file is longer than `lines`. */
  truncated: boolean
  isBinary: boolean
  /** Set when the file could not be read at all - deleted, or never committed. */
  error: string | null
}

/** How the two endpoints of a review resolved against the repository right now. */
export interface CompareEndpoint {
  ref: string
  sha: string | null
  shortSha: string | null
  /** Set when the ref no longer resolves - a deleted branch, say. */
  error: string | null
}

export interface ReviewCompare {
  base: CompareEndpoint
  head: CompareEndpoint
  /** Commit the branches diverged from; the diff is taken against this. */
  mergeBase: string | null
  /** The worktree with the head branch checked out, when one has it. */
  headWorktree: GitWorktree | null
  /** Uncommitted state of that worktree. Null when no worktree has the head. */
  workingTree: WorkingTreeChanges | null
  /** Human-readable reason the comparison could not be made, if any. */
  error: string | null
}

export interface ReviewCommits extends ReviewCompare {
  commits: GitCommit[]
  /** True when the range was longer than the app is willing to list. */
  truncated: boolean
}

export interface ReviewDiff extends ReviewCompare {
  files: FileDiff[]
  additions: number
  deletions: number
  /** Whether uncommitted work was actually folded into this diff. */
  includedUncommitted: boolean
  /** True when at least one file's patch was clipped. */
  truncated: boolean
}
