/**
 * The one place GitWarren spawns `git`.
 *
 * Both the repository-state reader (`git.ts`) and the review comparison code
 * (`git-compare.ts`) go through `runGit`, so there is a single answer to "how
 * does this app call git": same timeout, same hostile-environment scrubbing,
 * same treatment of a missing binary. Shelling out to the user's own git rather
 * than linking a git library is deliberate - it is the binary they already
 * trust, and it understands worktrees, submodules and `.git` files correctly,
 * which matters a great deal here.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath as realpathWithCallback } from 'node:fs'
import { stat } from 'node:fs/promises'
import { AppError } from '../shared/errors.js'

const execFileAsync = promisify(execFile)

/**
 * `fs/promises` has no `realpath.native`; only the callback API exposes it, and
 * the native variant is the one that reports true on-disk casing.
 */
const realpathNativeAsync = promisify(realpathWithCallback.native)

/** Git should answer instantly on a local path; this only trips on a hung mount. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * `execFile` truncates at 1 MB by default and then *throws*, which would turn a
 * big-but-ordinary branch diff into an unexplained failure. Diffs are read into
 * memory anyway, so the ceiling is generous but finite.
 */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

export interface GitResult {
  stdout: string
  stderr: string
  /** 0 on success. Non-zero is returned, not thrown - callers decide. */
  code: number
}

export interface RunGitOptions {
  timeoutMs?: number
  maxBuffer?: number
}

export async function runGit(
  args: string[],
  cwd: string,
  options: RunGitOptions = {}
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
      // Keep git from prompting for credentials or opening an editor; a blocked
      // child process would hang the IPC call forever. GIT_OPTIONAL_LOCKS=0
      // additionally stops read-only commands from taking the index lock, so
      // GitWarren can never interfere with a `git` the user is running in the
      // same worktree at the same moment.
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

/**
 * Like `runGit`, but without trimming. Diff and `-z` output is parsed by
 * position, so leading and trailing whitespace is data, not noise.
 */
export async function runGitRaw(
  args: string[],
  cwd: string,
  options: RunGitOptions = {}
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown }
    if (err.code === 'ENOENT') {
      throw new AppError(
        'GIT_UNAVAILABLE',
        'Could not run `git`. Make sure git is installed and available on your PATH.'
      )
    }
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: typeof err.code === 'number' ? err.code : 1
    }
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * `realpath.native` resolves symlinks *and* reports the true on-disk casing on
 * case-insensitive filesystems, which plain `realpath` does not.
 */
export async function canonicalise(path: string): Promise<string> {
  try {
    return await realpathNativeAsync(path)
  } catch {
    return path
  }
}
