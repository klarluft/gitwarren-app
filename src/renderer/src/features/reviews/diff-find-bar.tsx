/**
 * Find in the diff: the bar, and the state behind it.
 *
 * Modelled on the browser's own find rather than on a filter. Nothing is hidden
 * and no file is dropped from the page - the hits are marked where they are and
 * Enter walks them - because a reviewer reading a diff wants to see the change
 * around the word they were looking for, not the word on its own.
 *
 * The hook lives beside the bar rather than inside it because the tab needs the
 * same state twice over: to draw the bar, and to tell each file card which of
 * its lines is the one being pointed at.
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { plural } from '@/lib/format'
import { formatStep } from '@/lib/keys'
import { revealElement } from '@/lib/reveal'
import { cn } from '@/lib/utils'
import { findDiffMatches, type DiffMatch, type DiffSearch } from './diff-search'
import { ACTIVE_MATCH_ID } from './dom-ids'
import type { FileDiff } from '@shared/git'

export interface DiffFind {
  open: boolean
  /** What is in the field, which is what the field must render. */
  query: string
  setQuery: (query: string) => void
  /**
   * The query the hits below were found with - a beat behind `query` while
   * someone is still typing. What the bar says about the results has to be said
   * about this one, or a fast typist is told "no matches" about a query that
   * has not been run yet.
   */
  term: string
  matches: DiffMatch[]
  fileCount: number
  truncated: boolean
  /** Position of the current hit in `matches`, or -1 when there are none. */
  index: number
  /** Open the bar, or bring the focus back to a bar that is already open. */
  show: () => void
  close: () => void
  /** Move to the next hit (`1`) or the previous one (`-1`), wrapping. */
  step: (delta: number) => void
  /**
   * Handed to the field as its `ref`. A callback rather than the ref object
   * itself: the hook is the only thing that ever reaches for the element - to
   * put the focus in it - and the bar is left with nothing to hold.
   */
  bindInput: (input: HTMLInputElement | null) => void
  /** What to hand a file card, or undefined when no search is running. */
  searchFor: (path: string) => DiffSearch | undefined
}

export function useDiffFind(files: readonly FileDiff[]): DiffFind {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const bindInput = useCallback((node: HTMLInputElement | null) => {
    input.current = node
  }, [])

  /**
   * Matching runs against the settled query rather than the one being typed.
   * Every keystroke otherwise re-scans the whole diff and re-renders every row
   * before the next character can appear, which is exactly the moment the app
   * must not stutter. The field itself stays on `query`, so typing looks
   * instant even while the marks are a beat behind.
   */
  const applied = useDeferredValue(query)
  const term = open ? applied : ''

  const { matches, fileCount, truncated } = useMemo(
    () => findDiffMatches(files, term),
    [files, term]
  )

  // A new query is a new set of hits, so the walk restarts at the first one.
  // Adjusted during render the way the palette adjusts its highlight: React
  // re-runs this pass before painting, so the first frame of a new query is
  // already pointing at that query's first hit.
  const [termAtIndex, setTermAtIndex] = useState(term)
  if (termAtIndex !== term) {
    setTermAtIndex(term)
    setIndex(0)
  }

  // Clamped rather than stored: the diff can be refreshed underneath a search,
  // and an index left past the end would point at nothing.
  const current = matches.length === 0 ? -1 : Math.min(index, matches.length - 1)
  const active = current === -1 ? null : (matches[current] ?? null)

  const show = useCallback(() => {
    setOpen(true)
    // Already open: the effect below will not fire, so take the focus here.
    // Selecting rather than appending is what makes a second ⌘F mean "search
    // for something else" instead of "carry on typing this".
    input.current?.select()
  }, [])

  useEffect(() => {
    if (open) input.current?.select()
  }, [open])

  const close = useCallback(() => setOpen(false), [])

  const step = useCallback(
    (delta: number) => {
      const count = matches.length
      if (count === 0) return
      setIndex((previous) => (Math.min(previous, count - 1) + delta + count) % count)
    },
    [matches.length]
  )

  /**
   * Bring the current hit into view.
   *
   * `revealElement` retries across a few frames, which is what makes this work
   * on a hit inside a collapsed file: the card opens on this same render, and
   * the mark appears a frame or two later.
   */
  const activeKey =
    active === null ? null : `${active.filePath}:${active.side}:${active.line}:${active.occurrence}`

  useEffect(() => {
    if (active === null) return
    return revealElement(ACTIVE_MATCH_ID, {
      block: 'center',
      // The code scrolls sideways in a container of its own, so a hit past the
      // right edge has to be scrolled to there as well as down the page.
      // `nearest` rather than `center`: centring a mark that was already on
      // screen drags the line-number gutters off the left of it for nothing.
      inline: 'nearest',
      behavior: 'smooth'
    })
    // `activeKey` stands in for the match, which is a fresh object each search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  const searchFor = useCallback(
    (path: string): DiffSearch | undefined =>
      term === ''
        ? undefined
        : {
            query: term,
            active:
              active !== null && active.filePath === path
                ? { side: active.side, line: active.line, occurrence: active.occurrence }
                : null
          },
    [term, active]
  )

  return {
    open,
    query,
    setQuery,
    term,
    matches,
    fileCount,
    truncated,
    index: current,
    show,
    close,
    step,
    bindInput,
    searchFor
  }
}

export function DiffFindBar({ find }: { find: DiffFind }) {
  const { matches, index, query, term, truncated, fileCount, bindInput } = find
  const searching = term !== ''
  const none = searching && matches.length === 0

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'Enter':
        event.preventDefault()
        find.step(event.shiftKey ? -1 : 1)
        break
      case 'Escape':
        event.preventDefault()
        // The global layer would not see this anyway - React's own handler runs
        // first - but saying so here keeps the bar's keys in one place.
        event.stopPropagation()
        find.close()
        break
      default:
        break
    }
  }

  return (
    // Sticky, so the count and the arrows stay reachable while the diff scrolls
    // past underneath them - which is the whole time a search is being used.
    <div className="sticky top-0 z-20 flex items-center gap-2 rounded-lg border border-border bg-card/95 px-2 py-1.5 shadow-sm backdrop-blur">
      <Search className="ml-1 size-4 shrink-0 text-muted-foreground" />

      <Input
        ref={bindInput}
        value={query}
        onChange={(event) => find.setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in the diff"
        aria-label="Find in the diff"
        spellCheck={false}
        autoComplete="off"
        className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:outline-none"
      />

      {/* Announced rather than merely drawn: someone stepping through hits with
          the keyboard never looks at this line, and still needs to hear it. */}
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'shrink-0 whitespace-nowrap text-xs tabular-nums',
          none ? 'text-warning' : 'text-muted-foreground'
        )}
      >
        {!searching
          ? ''
          : none
            ? 'No matches'
            : `${index + 1} of ${matches.length}${truncated ? '+' : ''} in ${plural(fileCount, 'file')}`}
      </span>

      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => find.step(-1)}
          disabled={matches.length === 0}
          title={`Previous match (${formatStep('shift+enter')})`}
          aria-label="Previous match"
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => find.step(1)}
          disabled={matches.length === 0}
          title={`Next match (${formatStep('enter')})`}
          aria-label="Next match"
        >
          <ChevronDown />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => find.close()}
          title={`Close the find bar (${formatStep('escape')})`}
          aria-label="Close the find bar"
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
