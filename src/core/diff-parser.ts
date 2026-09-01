/**
 * Unified-diff parser.
 *
 * `git diff` is asked for a plain patch and parsed here rather than assembled
 * from `--numstat` plus `--raw` plus a patch, because the three would have to be
 * stitched back together on path equality - and paths are exactly the thing git
 * is allowed to quote, rename and re-encode. One pass over one patch keeps the
 * association between a file and its hunks structural instead of inferred.
 *
 * Two details this handles that a naive line-splitter gets wrong:
 *
 *  - **Paths come from `---`/`+++` and `rename from`/`rename to`, never from the
 *    `diff --git a/x b/x` line.** That line is genuinely ambiguous for paths
 *    containing spaces; the others are not, because the path runs to the end.
 *  - **A rename with no content change has no `---`/`+++` lines at all**, so the
 *    extended headers have to be able to name the file on their own.
 *
 * Callers pass `core.quotePath=false`, so only paths containing a quote,
 * backslash or control character arrive C-quoted; `unquotePath` covers those.
 */
import type { DiffHunk, DiffLine, FileDiff } from '../shared/git.js'

/**
 * Per-file line ceiling. A generated lockfile or a vendored bundle can be tens
 * of thousands of lines, which no reviewer reads and which would make the
 * renderer crawl; past this the file is marked `truncated` and still listed
 * with its real add/delete counts.
 */
const DEFAULT_MAX_LINES_PER_FILE = 4_000

export interface ParseDiffOptions {
  maxLinesPerFile?: number
}

const HUNK_HEADER = /^@@+ (?:-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? )+@@/

interface MutableFile extends FileDiff {
  /** Set once `---`/`+++` have been seen, so extended headers can't overwrite. */
  pathsFromPatch: boolean
}

function emptyFile(): MutableFile {
  return {
    path: '',
    oldPath: null,
    status: 'modified',
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    truncated: false,
    isUntracked: false,
    hasUncommittedChanges: false,
    pathsFromPatch: false
  }
}

/**
 * Reverse git's C-style quoting. Only applied to values that actually start
 * with a quote, which is the same test git uses when deciding to quote.
 */
export function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value
  const body = value.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = body[i + 1]
    i += 1
    switch (next) {
      case 'n':
        out += '\n'
        break
      case 't':
        out += '\t'
        break
      case 'r':
        out += '\r'
        break
      case '"':
        out += '"'
        break
      case '\\':
        out += '\\'
        break
      default:
        // Octal escape (\303 …), which is how git encodes raw bytes.
        if (next !== undefined && next >= '0' && next <= '7') {
          const octal = body.slice(i, i + 3)
          out += String.fromCharCode(parseInt(octal, 8))
          i += 2
        } else if (next !== undefined) {
          out += next
        }
    }
  }
  // Octal escapes above produced bytes, not characters; re-decode as UTF-8 so a
  // non-ASCII filename reads correctly rather than as mojibake.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(out, (character) => character.charCodeAt(0) & 0xff)
    )
  } catch {
    return out
  }
}

/** Strip the `a/` or `b/` prefix git adds, after unquoting. */
function stripPrefix(value: string): string {
  const path = unquotePath(value.trim())
  if (path === '/dev/null') return ''
  return path.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(patch: string, options: ParseDiffOptions = {}): FileDiff[] {
  const maxLines = options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE
  if (!patch.trim()) return []

  const files: MutableFile[] = []
  let file: MutableFile | null = null
  let hunk: DiffHunk | null = null
  let oldNumber = 0
  let newNumber = 0

  const finishFile = (): void => {
    if (!file) return
    // A deletion has no head-side path; fall back to where it used to live.
    if (!file.path && file.oldPath) file.path = file.oldPath
    files.push(file)
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finishFile()
      file = emptyFile()
      hunk = null
      continue
    }

    if (!file) continue

    if (line.startsWith('@@')) {
      const match = HUNK_HEADER.exec(line)
      if (match) {
        oldNumber = Number(match[1])
        newNumber = Number(match[3])
        hunk = {
          header: line,
          oldStart: oldNumber,
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: newNumber,
          newLines: match[4] === undefined ? 1 : Number(match[4]),
          lines: []
        }
        file.hunks.push(hunk)
      }
      continue
    }

    if (hunk === null) {
      // Still in the header block for this file.
      if (line.startsWith('--- ')) {
        const path = stripPrefix(line.slice(4))
        if (path) file.oldPath = path
        file.pathsFromPatch = true
        continue
      }
      if (line.startsWith('+++ ')) {
        const path = stripPrefix(line.slice(4))
        if (path) file.path = path
        file.pathsFromPatch = true
        continue
      }
      if (line.startsWith('new file mode')) {
        file.status = 'added'
        continue
      }
      if (line.startsWith('deleted file mode')) {
        file.status = 'deleted'
        continue
      }
      if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = unquotePath(line.slice('rename from '.length))
        continue
      }
      if (line.startsWith('rename to ')) {
        file.status = 'renamed'
        file.path = unquotePath(line.slice('rename to '.length))
        continue
      }
      if (line.startsWith('copy from ')) {
        file.status = 'copied'
        file.oldPath = unquotePath(line.slice('copy from '.length))
        continue
      }
      if (line.startsWith('copy to ')) {
        file.status = 'copied'
        file.path = unquotePath(line.slice('copy to '.length))
        continue
      }
      if (line.startsWith('old mode ')) {
        // Overwritten by a later `new file`/`rename` header if there is one.
        if (file.status === 'modified') file.status = 'changed'
        continue
      }
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.isBinary = true
        continue
      }
      continue
    }

    // Inside a hunk.
    if (line.startsWith('\\')) continue // "\ No newline at end of file"

    const marker = line[0]
    if (marker !== ' ' && marker !== '+' && marker !== '-') {
      // Anything else ends the hunk block (a trailing "-- " signature, say).
      hunk = null
      continue
    }

    const content = line.slice(1)
    if (marker === '+') file.additions += 1
    if (marker === '-') file.deletions += 1

    if (hunk.lines.length >= maxLines) {
      file.truncated = true
    } else {
      const entry: DiffLine =
        marker === ' '
          ? { type: 'context', content, oldNumber, newNumber }
          : marker === '+'
            ? { type: 'insert', content, oldNumber: null, newNumber }
            : { type: 'delete', content, oldNumber, newNumber: null }
      hunk.lines.push(entry)
    }

    if (marker !== '+') oldNumber += 1
    if (marker !== '-') newNumber += 1
  }

  finishFile()

  return files.map(({ pathsFromPatch: _pathsFromPatch, ...rest }) => rest)
}

/**
 * Build a "whole file is new" diff for a file that git has never seen.
 *
 * Untracked files are synthesised rather than staged into a scratch index: the
 * index approach means writing blobs into the user's object database just to
 * render a screen, and this app's contract is that it only ever reads.
 */
export function buildUntrackedFileDiff(
  path: string,
  content: string,
  options: { isBinary: boolean; maxLines?: number }
): FileDiff {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES_PER_FILE

  if (options.isBinary) {
    return {
      path,
      oldPath: null,
      status: 'added',
      isBinary: true,
      additions: 0,
      deletions: 0,
      hunks: [],
      truncated: false,
      isUntracked: true,
      hasUncommittedChanges: true
    }
  }

  // A trailing newline terminates the last line rather than starting a new one.
  const raw = content.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()

  const lines: DiffLine[] = raw
    .slice(0, maxLines)
    .map((text, index) => ({ type: 'insert', content: text, oldNumber: null, newNumber: index + 1 }))

  const hunks: DiffHunk[] =
    raw.length === 0
      ? []
      : [
          {
            header: `@@ -0,0 +1,${raw.length} @@`,
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: raw.length,
            lines
          }
        ]

  return {
    path,
    oldPath: null,
    status: 'added',
    isBinary: false,
    additions: raw.length,
    deletions: 0,
    hunks,
    truncated: raw.length > maxLines,
    isUntracked: true,
    hasUncommittedChanges: true
  }
}
