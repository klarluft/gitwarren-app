/**
 * Searching the *contents* of a review's repository - find in files.
 *
 * The browse tab could already answer "where is the file called X". This
 * answers the question a reviewer actually arrives with: "where is the function
 * called X", asked while reading a diff that called it. Until now the answer
 * was to leave GitWarren, and anything noticed over there had nowhere to be
 * written down - the same argument that produced the browse tab in the first
 * place, one step further along.
 *
 * ## Why `git grep` and not a walk of the tree
 *
 * The same three reasons `readReviewTree` uses `ls-files`. It already honours
 * `.gitignore`, so `node_modules` and build output stay out of the results
 * exactly as they stay out of a commit. It can search a *commit* as well as a
 * worktree, which is what lets this follow the same "which head" rule as every
 * other read here. And it is one process rather than one read per file, over
 * what may be an `ssh` pipe.
 *
 * It also means the include and exclude boxes are git pathspecs underneath, and
 * pathspecs are the one glob dialect guaranteed to agree with the rest of this
 * app.
 *
 * ## What comes back, and what does not
 *
 * Matching *lines*, not matching *offsets*. Where on the line the hit is gets
 * worked out in the renderer by `matchOffsets`, the same function that draws
 * the find bar's marks in the diff - so a highlight in the search results and a
 * highlight in the file the reader then opens can never be drawn differently.
 * Shipping columns would be a second opinion about the same string.
 */
import { effectiveChanges, resolveCompare } from './git-compare.js'
import { runGitRaw } from './git-exec.js'
import type { DiffChanges, ReviewSearch, SearchFileMatches } from '../shared/git.js'

/**
 * How many matching lines a search will carry back.
 *
 * Generous enough that a real search over a real repository is never clipped,
 * small enough that `e` over a monorepo does not try to render a novel. Past it
 * the result says it was cut short, which is the honest thing to do with a
 * query that was too broad to be useful anyway.
 */
export const MAX_SEARCH_LINES = 2_000

/**
 * Past this a matching line is shown clipped.
 *
 * A minified bundle is one line a megabyte long, and it is still a legitimate
 * hit - `git grep -I` calls it text because it is. Clipping keeps one such file
 * from being the entire payload while still saying the match is there.
 */
const MAX_LINE_LENGTH = 400

/** Git's own limit on how much output this will read before giving up. */
const MAX_SEARCH_BYTES = 32 * 1024 * 1024

/** A search can walk a large checkout; it gets longer than a `git log` does. */
const SEARCH_TIMEOUT_MS = 30_000

export interface SearchOptions {
  changes: DiffChanges
  /** What to look for. Empty means "no search"; callers must not get here. */
  query: string
  /** Read `query` as a POSIX extended regular expression rather than literally. */
  isRegex: boolean
  /** Off means a case-insensitive search, which is what a reader expects first. */
  matchCase: boolean
  /** Comma-separated globs; empty means every file. */
  include: string
  /** Comma-separated globs, applied after `include`. */
  exclude: string
}

/** Characters that make a pattern a glob rather than a plain path. */
const GLOB_META = /[*?[\]]/

/**
 * One box of comma-separated globs, as git pathspecs.
 *
 * The rules are VS Code's, because that is the search box people already have
 * the habit of, and every one of them exists to make the obvious thing work:
 *
 *  - `*.ts` names a file *anywhere*, so a pattern with no `/` in it is matched
 *    at any depth. Left alone, `:(glob)*.ts` would only ever match at the root,
 *    because a `*` in a glob pathspec does not cross a separator.
 *  - `src/reviews` names a *folder*, so a pattern with no glob character in it
 *    becomes two pathspecs - the path itself, and everything under it. Guessing
 *    which one was meant is the one thing that cannot be got right; matching
 *    both is always what the person wanted.
 *  - `src/` with a trailing slash says "the folder" out loud, and only gets the
 *    second form.
 *
 * Everything is emitted behind `:(glob)`, which besides choosing the dialect
 * also means a pattern beginning with `:` is a pattern rather than pathspec
 * magic of the user's own - these strings arrive from a text box.
 */
export function toPathspecs(patterns: string, kind: 'include' | 'exclude'): string[] {
  const prefix = kind === 'include' ? ':(glob)' : ':(exclude,glob)'
  const specs: string[] = []

  for (const raw of patterns.split(/[,\n]/)) {
    const trimmed = raw.trim().replace(/^\.\//, '')
    if (trimmed === '') continue

    const isFolder = trimmed.endsWith('/')
    const hasGlob = GLOB_META.test(trimmed)
    const body = isFolder ? trimmed.slice(0, -1) : trimmed
    if (body === '') continue

    // No separator anywhere in it: a name, not a location. Match it wherever
    // it turns up.
    const anchored = body.includes('/') ? body : `**/${body}`

    if (isFolder) specs.push(`${prefix}${anchored}/**`)
    else if (hasGlob) specs.push(`${prefix}${anchored}`)
    else specs.push(`${prefix}${anchored}`, `${prefix}${anchored}/**`)
  }

  return specs
}

/**
 * `git grep -z -n` output, as files and their matching lines.
 *
 * The format is `<path>NUL<line>NUL<text>LF` per hit, and the parse walks NUL
 * boundaries rather than lines because the last field is the only one that can
 * hold anything: splitting on `LF` first would come apart on a path with a
 * newline in it, which git is perfectly willing to track. Matched text can
 * never contain one - grep is line-oriented - so the first `LF` after a hit is
 * always the record boundary, and everything after it is the next path.
 *
 * `revPrefix` is what a commit search puts in front of every path
 * (`<sha>:src/app.ts`); it is stripped here so a caller cannot tell which of
 * the two heads answered.
 */
export function parseGrepOutput(
  stdout: string,
  revPrefix: string,
  limit: number = MAX_SEARCH_LINES
): { files: SearchFileMatches[]; lineCount: number; truncated: boolean } {
  const files: SearchFileMatches[] = []
  const byPath = new Map<string, SearchFileMatches>()
  let lineCount = 0
  let truncated = false

  const fields = stdout.split('\0')
  // Three fields per record, except that the third carries the next record's
  // path glued onto it by the separating newline.
  let path = fields.length > 0 ? (fields[0] as string) : ''

  for (let at = 1; at + 1 < fields.length; at += 2) {
    const rawLine = fields[at] as string
    const rest = fields[at + 1] as string

    const cut = rest.indexOf('\n')
    // No newline left: git's output was cut off mid-record, by the buffer
    // ceiling or by a kill. What is there is still a real hit, so it counts.
    const text = cut === -1 ? rest : rest.slice(0, cut)
    const next = cut === -1 ? '' : rest.slice(cut + 1)

    const line = Number(rawLine)
    if (Number.isInteger(line) && line > 0 && path !== '') {
      const named = path.startsWith(revPrefix) ? path.slice(revPrefix.length) : path

      if (lineCount >= limit) {
        truncated = true
        break
      }

      let file = byPath.get(named)
      if (file === undefined) {
        file = { path: named, lines: [] }
        byPath.set(named, file)
        files.push(file)
      }

      file.lines.push({
        text: text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) : text,
        line,
        clipped: text.length > MAX_LINE_LENGTH
      })
      lineCount += 1
    }

    path = next
    if (next === '') break
  }

  return { files, lineCount, truncated }
}

/**
 * Every line of the repository, at this review's head, that matches.
 *
 * Which *head* is settled the same way `readReviewTree` settles it, by the same
 * two calls, so the browse tab's file list and its search always describe one
 * version of the repository: the worktree when one holds the head branch and
 * the reader has not narrowed to the commits, the head commit otherwise.
 */
export async function searchReviewFiles(
  repositoryPath: string,
  baseRef: string,
  headRef: string,
  options: SearchOptions
): Promise<ReviewSearch> {
  const query = options.query
  const empty = { files: [], lineCount: 0, fileCount: 0, truncated: false }

  const compare = await resolveCompare(repositoryPath, baseRef, headRef)
  const changes = effectiveChanges(options.changes, compare)
  const worktree = changes === 'committed' ? null : compare.headWorktree
  const source = worktree === null ? 'commit' : 'worktree'

  if (query === '') return { ...empty, source, error: null }

  if (worktree === null && !compare.head.sha) {
    return { ...empty, source, error: compare.error ?? 'The head ref does not resolve to a commit.' }
  }

  const pathspecs = [
    ...toPathspecs(options.include, 'include'),
    ...toPathspecs(options.exclude, 'exclude')
  ]

  const flags = [
    // `-I` drops binary files: a hit inside a PNG is a row nobody can read and
    // a file nobody can open here.
    '-I',
    '-n',
    '-z',
    '--no-color',
    options.isRegex ? '-E' : '-F',
    ...(options.matchCase ? [] : ['-i'])
  ]

  // A commit search names the commit; a worktree search adds the files that
  // are not committed yet, matching what the file list beside it shows.
  const head = worktree === null ? [compare.head.sha as string] : ['--untracked']
  const revPrefix = worktree === null ? `${compare.head.sha as string}:` : ''

  const result = await runGitRaw(
    [
      '-c',
      'core.quotePath=false',
      'grep',
      ...flags,
      // `-e` so a query beginning with `-` is a query rather than an option.
      '-e',
      query,
      ...head,
      '--',
      ...pathspecs
    ],
    worktree === null ? repositoryPath : worktree.path,
    { timeoutMs: SEARCH_TIMEOUT_MS, maxBuffer: MAX_SEARCH_BYTES }
  )

  // git grep says "found nothing" with exit code 1, the way grep always has.
  // Anything above that is a real failure - a bad regular expression, most
  // often, which is a thing the person typing can fix and should be told about.
  if (result.code > 1) {
    const output = result.stdout
    if (output === '') {
      return {
        ...empty,
        source,
        error: result.stderr.trim().replace(/^fatal: /, '') || 'The search could not be run.'
      }
    }
    // Output *and* a failure means the ceiling was hit and git was killed
    // part-way. The hits that arrived are real; say there are more.
    const parsed = parseGrepOutput(output, revPrefix)
    return {
      files: parsed.files,
      lineCount: parsed.lineCount,
      fileCount: parsed.files.length,
      source,
      truncated: true,
      error: null
    }
  }

  const parsed = parseGrepOutput(result.stdout, revPrefix)

  return {
    files: parsed.files,
    lineCount: parsed.lineCount,
    fileCount: parsed.files.length,
    source,
    truncated: parsed.truncated,
    error: null
  }
}
