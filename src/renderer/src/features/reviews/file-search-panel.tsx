/**
 * Find in files: the panel in the browse tab's sidebar.
 *
 * The browse tab could already answer "where is the file called X". This
 * answers the question a reviewer actually arrives with - "where is the
 * function called X" - asked halfway down a diff that called it. Until now the
 * answer was to leave GitWarren, and anything noticed over there had nowhere to
 * be written down.
 *
 * ## Shaped like the search people already have
 *
 * A query, three toggles beside it, and two glob boxes under a disclosure:
 * VS Code's panel, because that is the one whose habits a reviewer brings with
 * them. `files to include` and `files to exclude` take the same
 * comma-separated globs, and mean the same thing - `src`, `*.ts`,
 * `**\/*.test.ts` - which is worth more than any dialect this app could invent.
 * They become git pathspecs in `core/git-search.ts`.
 *
 * Results are grouped by file and each file is foldable, because a search that
 * matched forty times in one file and once in another should not bury the one.
 *
 * ## Where the state lives, and why it is split
 *
 * The **query** is in the URL. A search is a place: it survives a reload, the
 * back button walks out of it, and `#/reviews/4/browse?q=resolveAnchor` is a
 * thing a person can paste to a colleague or an agent can write into a comment.
 * It is also what lets the find bar in Files changed hand a word over here with
 * nothing but a link - see `DiffFindBar`.
 *
 * The **toggles and the glob boxes** are preferences, in `localStorage`. They
 * are not what you are looking for, they are how you look: a person who never
 * wants to see `dist/` wants that on the next search too, and on the one after
 * a restart. Putting them in the link as well would mean a pasted search
 * carried the sender's habits into the recipient's window.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import {
  AlertCircle,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  RotateCw,
  Search,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/format'
import { useStoredFlag, useStoredPreference } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { matchOffsets } from './diff-search'
import { useReviewSearch } from './use-reviews'
import type { DiffChanges, ReviewSearch, SearchFileMatches, SearchLine } from '@shared/git'

/**
 * How long the typing has to stop before the search runs.
 *
 * Long enough that a word typed at speed is one search rather than seven, short
 * enough that it never feels like waiting. A `git grep` over a large checkout
 * is tens of milliseconds, so this is not about the search being slow - it is
 * about not asking for six answers nobody will read.
 */
const SETTLE_MS = 250

export interface FileSearchPanelProps {
  reviewId: number
  changes: DiffChanges
  /** The query, which lives in the route - see the note at the top. */
  query: string
  onQueryChange: (query: string) => void
  /** Open this file at this line. The panel never navigates on its own. */
  onOpen: (path: string, line: number) => void
  /** The file the tab is showing, so its results can be marked as current. */
  selectedPath: string | null
}

export function FileSearchPanel({
  reviewId,
  changes,
  query,
  onQueryChange,
  onOpen,
  selectedPath
}: FileSearchPanelProps) {
  const [matchCase, setMatchCase] = useStoredFlag('search-case', false)
  const [isRegex, setIsRegex] = useStoredFlag('search-regex', false)
  const [include, setInclude] = useStoredPreference('search-include', '')
  const [exclude, setExclude] = useStoredPreference('search-exclude', '')
  const [filtersOpen, setFiltersOpen] = useStoredFlag('search-filters', false)

  /**
   * What is in the box, as against what has been searched for.
   *
   * Two values because the field has to keep up with a typist and the location
   * must not. Writing the route on every keystroke would spawn a `git grep` per
   * character *and* re-render the file open beside the panel - which may be
   * five thousand rows - between one letter and the next. So the field is local
   * and the location catches up when the typing pauses: `query` is always a
   * search that actually ran, which is also what makes it worth putting in a
   * link.
   */
  const [typed, setTyped] = useState(query)

  /**
   * A query arriving from somewhere else replaces what is in the field - a
   * pasted link, the back button, a word handed over from Files changed.
   *
   * Adjusted during render rather than in an effect, the way `useDiffFind`
   * resets its walk: React re-runs this pass before painting, so the first
   * frame of the new location already shows the new query rather than showing
   * the old one and correcting it.
   */
  const [routeQuery, setRouteQuery] = useState(query)
  if (routeQuery !== query) {
    setRouteQuery(query)
    setTyped(query)
  }

  useEffect(() => {
    if (typed === query) return
    const timer = setTimeout(() => onQueryChange(typed), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [typed, query, onQueryChange])

  /**
   * The cursor is in the field as soon as the panel is.
   *
   * This panel only ever appears because somebody asked for it - a button, a
   * shortcut, a link - and in every one of those cases the next thing they mean
   * to do is type. Selecting rather than placing a caret means arriving with a
   * query already in the box (from Files changed, say) and typing replaces it,
   * which is what a second press of a search shortcut means everywhere else.
   */
  const field = useRef<HTMLInputElement | null>(null)
  useEffect(() => field.current?.select(), [])

  const term = query.trim()

  const search = useReviewSearch(reviewId, changes, {
    query: term,
    isRegex,
    matchCase,
    include: include ?? '',
    exclude: exclude ?? ''
  })

  const result = search.data
  const settled = typed.trim() === term
  const filtered = (include ?? '') !== '' || (exclude ?? '') !== ''

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-card px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={field}
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
              // Enter runs what has been typed without waiting for the pause,
              // for the reader who types a word and expects an answer now.
              if (event.key === 'Enter') {
                event.preventDefault()
                if (typed !== query) onQueryChange(typed)
                return
              }
              if (event.key !== 'Escape' || typed === '') return
              event.preventDefault()
              event.stopPropagation()
              setTyped('')
            }}
            placeholder="Search in files"
            aria-label="Search the contents of every file in this repository"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <Toggle
            on={matchCase}
            onChange={setMatchCase}
            label="Match case"
            icon={<CaseSensitive className="size-3.5" />}
          />
          <Toggle
            on={isRegex}
            onChange={setIsRegex}
            label="Use a regular expression"
            icon={<Regex className="size-3.5" />}
          />
          <Toggle
            on={filtersOpen}
            onChange={setFiltersOpen}
            label={filtersOpen ? 'Hide the file filters' : 'Filter which files are searched'}
            // A dot when something is set, so a search narrowed to `*.ts` and
            // then folded away cannot quietly explain a missing result.
            marked={filtered}
            icon={<SlidersHorizontal className="size-3.5" />}
          />
        </div>

        {filtersOpen && (
          <div className="flex flex-col gap-1">
            <GlobField
              value={include ?? ''}
              onChange={setInclude}
              label="Files to include"
              placeholder="src, *.ts"
            />
            <GlobField
              value={exclude ?? ''}
              onChange={setExclude}
              label="Files to exclude"
              placeholder="**/*.test.ts, dist"
            />
            <p className="px-0.5 text-[0.625rem] leading-relaxed text-muted-foreground">
              Comma-separated. A name with no slash matches at any depth; a name
              with no <span className="font-mono">*</span> also matches everything under it.
            </p>
          </div>
        )}
      </div>

      <SearchStatus
        term={term}
        settled={settled}
        error={search.error}
        result={result}
        isLoading={search.isLoading}
        isRefreshing={search.isRefreshing}
        onRefresh={() => void search.refresh()}
      />

      {result !== undefined && result.error === null && result.files.length > 0 && (
        <nav aria-label="Search results" className="flex flex-col py-1 text-xs">
          {result.files.map((file) => (
            <FileResults
              key={file.path}
              file={file}
              query={term}
              isRegex={isRegex}
              matchCase={matchCase}
              onOpen={onOpen}
              isSelected={file.path === selectedPath}
            />
          ))}
        </nav>
      )}
    </div>
  )
}

/** One of the small switches beside the query field. */
function Toggle({
  on,
  onChange,
  label,
  icon,
  marked = false
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
  icon: ReactNode
  /** Draws the corner dot: something is set behind this even when it is off. */
  marked?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={label}
      aria-label={label}
      className={cn(
        'relative shrink-0 rounded p-0.5 transition-colors',
        on
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {icon}
      {marked && !on && (
        <span className="absolute right-0 top-0 size-1.5 rounded-full bg-primary" />
      )}
    </button>
  )
}

function GlobField({
  value,
  onChange,
  label,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder: string
}) {
  return (
    <label className="flex items-center gap-1.5 rounded border border-border px-1.5 py-1">
      <span className="sr-only">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent font-mono text-[0.6875rem] outline-none placeholder:text-muted-foreground"
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLowerCase()}`}
          className="shrink-0 rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </label>
  )
}

/**
 * The line between the field and the results: what was found, or why nothing
 * was.
 *
 * One component because these are one sentence in five moods, and a screen that
 * tells you "no results" while a search is still running is a screen that gets
 * closed.
 */
function SearchStatus({
  term,
  settled,
  error,
  result,
  isLoading,
  isRefreshing,
  onRefresh
}: {
  term: string
  /** False while the field is ahead of the search behind it. */
  settled: boolean
  error: unknown
  result: ReviewSearch | undefined
  isLoading: boolean
  isRefreshing: boolean
  onRefresh: () => void
}) {
  if (term === '') {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        Search every file in the repository at this review’s head — not only the ones it changed.
      </p>
    )
  }

  if (error !== undefined && error !== null) {
    return (
      <p className="flex items-start gap-2 px-3 py-3 text-xs text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        {errorMessage(error)}
      </p>
    )
  }

  if (isLoading || result === undefined) {
    return <p className="px-3 py-4 text-xs text-muted-foreground">Searching…</p>
  }

  // A bad regular expression, most often - which is a thing the person typing
  // can fix, so it is said plainly rather than as "no results".
  if (result.error !== null) {
    return (
      <p className="flex items-start gap-2 px-3 py-3 text-xs text-warning">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        {result.error}
      </p>
    )
  }

  if (result.files.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {settled ? 'No file contains that.' : 'Searching…'}
      </p>
    )
  }

  return (
    <p className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
      <span role="status" aria-live="polite" className="flex-1">
        {plural(result.lineCount, 'matching line')}
        {result.truncated && '+'} in {plural(result.fileCount, 'file')}
        {result.truncated && ' — narrow the search to see the rest'}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        title="Run the search again"
        aria-label="Run the search again"
        className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
      >
        <RotateCw className={cn('size-3', isRefreshing && 'animate-spin')} />
      </button>
    </p>
  )
}

/** One file's hits, folded under its path. */
function FileResults({
  file,
  query,
  isRegex,
  matchCase,
  onOpen,
  isSelected
}: {
  file: SearchFileMatches
  query: string
  isRegex: boolean
  matchCase: boolean
  onOpen: (path: string, line: number) => void
  isSelected: boolean
}) {
  const [open, setOpen] = useState(true)
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  const directory = file.path.slice(0, file.path.length - name.length)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        title={file.path}
        className={cn(
          'flex w-full items-start gap-1 rounded px-1 py-1 text-left hover:bg-muted',
          isSelected && 'bg-accent/40'
        )}
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 break-words font-mono text-[0.6875rem]">
          <span className="font-medium text-foreground">{name}</span>
          {directory !== '' && (
            <span className="text-muted-foreground"> {directory.slice(0, -1)}</span>
          )}
        </span>
        <span className="mt-px shrink-0 rounded-full bg-muted px-1.5 text-[0.5625rem] font-semibold leading-4 text-muted-foreground">
          {file.lines.length}
        </span>
      </button>

      {open &&
        file.lines.map((hit) => (
          <MatchRow
            key={hit.line}
            hit={hit}
            query={query}
            isRegex={isRegex}
            matchCase={matchCase}
            onOpen={() => onOpen(file.path, hit.line)}
          />
        ))}
    </>
  )
}

/**
 * One matching line, with the hit picked out of it.
 *
 * Marked here, in the renderer, rather than by columns sent down the wire - see
 * the note at the top of `core/git-search.ts`. For a literal search that is
 * `matchOffsets`, the same function that marks the diff's find bar. For a
 * regular expression it is a `RegExp` built from the same pattern, which is a
 * *best effort* and says so: git matched with POSIX rules and JavaScript's are
 * not identical, so a pattern the two disagree about shows the line unmarked
 * rather than marked in the wrong place. The row is still a real hit, found by
 * git, and clicking it still goes to the right line.
 */
function MatchRow({
  hit,
  query,
  isRegex,
  matchCase,
  onOpen
}: {
  hit: SearchLine
  query: string
  isRegex: boolean
  matchCase: boolean
  onOpen: () => void
}) {
  // Leading indentation is a column of nothing in a list this narrow; the line
  // number beside it already says where the line is.
  const text = hit.text.replace(/^\s+/, '')

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Line ${hit.line}`}
      className="flex w-full items-start gap-2 rounded py-0.5 pl-5 pr-1 text-left hover:bg-muted"
    >
      <span className="mt-px shrink-0 font-mono text-[0.5625rem] tabular-nums text-muted-foreground">
        {hit.line}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[0.6875rem] text-muted-foreground">
        <Marked text={text} query={query} isRegex={isRegex} matchCase={matchCase} />
        {hit.clipped && <span className="text-muted-foreground/60">…</span>}
      </span>
    </button>
  )
}

function Marked({
  text,
  query,
  isRegex,
  matchCase
}: {
  text: string
  query: string
  isRegex: boolean
  matchCase: boolean
}) {
  const ranges = isRegex
    ? regexRanges(text, query, matchCase)
    : literalRanges(text, query, matchCase)
  if (ranges.length === 0) return <>{text}</>

  const parts: ReactNode[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <mark key={start} className="rounded-[2px] bg-warning/25 text-foreground">
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function literalRanges(text: string, query: string, matchCase: boolean): [number, number][] {
  // `matchOffsets` folds case itself, which is what a case-insensitive search
  // wants. A case-sensitive one has to compare the strings as they are.
  if (!matchCase) {
    return matchOffsets(text, query).map((at) => [at, at + query.length] as [number, number])
  }

  const found: [number, number][] = []
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
    found.push([at, at + query.length])
  }
  return found
}

function regexRanges(text: string, query: string, matchCase: boolean): [number, number][] {
  let pattern: RegExp
  try {
    pattern = new RegExp(query, matchCase ? 'g' : 'gi')
  } catch {
    // A pattern git accepted and JavaScript will not. The line is still a hit.
    return []
  }

  const found: [number, number][] = []
  for (const match of text.matchAll(pattern)) {
    // A pattern that can match nothing - `a*` - would otherwise mark every
    // position in the line and never advance.
    if (match[0] === '' || match.index === undefined) break
    found.push([match.index, match.index + match[0].length])
    if (found.length >= 50) break
  }
  return found
}
