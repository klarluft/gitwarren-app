/**
 * The ⌘K panel.
 *
 * Two kinds of thing share one list. Commands come from the registry - whatever
 * the current screen says it can do - and destinations are read from the SWR
 * cache: every tracked repository, every review, and the files of the review
 * you have open. Both are matched with the same fuzzy scorer, so one query runs
 * across "what can I do" and "where can I go" without the reader having to
 * decide which of those they meant before they start typing.
 *
 * Destinations are read from the cache rather than fetched. The repositories
 * and reviews lists are cheap database reads that the shell has already made;
 * a diff is neither, and opening a palette is not a good enough reason to start
 * a git process. So the files of a review appear here once its Files changed
 * tab has loaded them, and quietly do not before that.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { CornerDownLeft, FileDiff, FolderGit2, GitPullRequestArrow, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { api, CACHE_KEYS } from '@/lib/api'
import { scoreCandidate, type FuzzyMatch } from '@/lib/fuzzy'
import { basename } from '@/lib/path'
import { revealElement } from '@/lib/reveal'
import { navigate, useRoute } from '@/lib/router'
import { cn } from '@/lib/utils'
import { fileDomId } from '@/features/reviews/dom-ids'
import {
  useCommands,
  type Command,
  type CommandGroup,
  COMMAND_GROUPS
} from './command-registry'
import type { ReviewDiff } from '@shared/git'
import type { RepositoryWithGitState, Review } from '@shared/schemas'

/** Rows rendered at most, so a repository with a thousand-file diff stays fast. */
const MAX_ROWS = 60
/** Per group, before anything is typed: a preview, not the whole database. */
const PREVIEW_PER_GROUP = 5

interface PaletteItem {
  id: string
  label: string
  group: CommandGroup
  run: () => void
  keywords?: string
  hint?: string
  keys?: string
  icon?: ComponentType<{ className?: string }>
  disabled?: boolean
}

interface ScoredItem {
  item: PaletteItem
  match: FuzzyMatch
}

interface Section {
  group: CommandGroup
  members: ScoredItem[]
  /** Where this section's first row sits in the flattened list. */
  start: number
}

function toPaletteItem(command: Command): PaletteItem {
  return {
    id: command.id,
    label: command.label,
    group: command.group,
    run: command.run,
    ...(command.keywords === undefined ? {} : { keywords: command.keywords }),
    ...(command.hint === undefined ? {} : { hint: command.hint }),
    ...(command.keys === undefined ? {} : { keys: command.keys }),
    ...(command.icon === undefined ? {} : { icon: command.icon }),
    ...(command.disabled === undefined ? {} : { disabled: command.disabled })
  }
}

/**
 * The changed files of the open review, if some tab has already read them.
 *
 * Both settings of "include uncommitted" are checked because either may be the
 * one on screen, and a file list is a file list - the switch changes the line
 * numbers, not which files are in play.
 */
function useCachedDiffFiles(reviewId: number | null): string[] {
  const { cache } = useSWRConfig()

  return useMemo(() => {
    if (reviewId === null) return []
    for (const includeUncommitted of [true, false]) {
      const entry = cache.get(CACHE_KEYS.reviewDiff(reviewId, includeUncommitted)) as
        | { data?: ReviewDiff }
        | undefined
      const files = entry?.data?.files
      if (files && files.length > 0) return files.map((file) => file.path)
    }
    return []
  }, [cache, reviewId])
}

function useDestinations(): PaletteItem[] {
  const route = useRoute()
  const reviewId = route.name === 'review' ? route.reviewId : null

  // Both are indexed database reads with no git in them, and both are already
  // cached by the screens behind the palette in the common case.
  const { data: repositories } = useSWR<RepositoryWithGitState[], unknown>(
    CACHE_KEYS.repositories,
    () => api.repositories.list()
  )
  const { data: reviews } = useSWR<Review[], unknown>(CACHE_KEYS.reviews(), () =>
    api.reviews.list({})
  )
  const files = useCachedDiffFiles(reviewId)

  return useMemo(() => {
    const repositoryNames = new Map((repositories ?? []).map((one) => [one.id, one.name]))

    const repositoryItems: PaletteItem[] = (repositories ?? []).map((repository) => ({
      id: `repository:${repository.id}`,
      label: repository.name,
      group: 'Repositories',
      hint: repository.path,
      keywords: repository.path,
      icon: FolderGit2,
      run: () => navigate({ name: 'repository', repositoryId: repository.id })
    }))

    const reviewItems: PaletteItem[] = (reviews ?? []).map((review) => ({
      id: `review:${review.id}`,
      label: review.title,
      group: 'Reviews',
      hint: repositoryNames.get(review.repositoryId) ?? `${review.headRef} → ${review.baseRef}`,
      // A review is as often remembered by its branch as by its title, and the
      // repository it lives in is the other thing anyone would type.
      keywords: `${review.headRef} ${review.baseRef} ${review.status} ${
        repositoryNames.get(review.repositoryId) ?? ''
      }`,
      icon: GitPullRequestArrow,
      run: () => navigate({ name: 'review', reviewId: review.id, tab: 'conversation' })
    }))

    const fileItems: PaletteItem[] = files.map((path) => ({
      id: `file:${path}`,
      // The name is what gets typed; the directory is context for telling two
      // `index.ts` apart, so it goes in the hint where it is not matched twice.
      label: basename(path),
      group: 'Jump to file',
      hint: path,
      keywords: path,
      icon: FileDiff,
      run: () => {
        if (reviewId === null) return
        navigate({ name: 'review', reviewId, tab: 'files' })
        revealElement(fileDomId(path))
      }
    }))

    return [...fileItems, ...reviewItems, ...repositoryItems]
  }, [repositories, reviews, files, reviewId])
}

/**
 * Filter, score and group.
 *
 * With a query, groups are ordered by their strongest member rather than by the
 * fixed section order: typing most of a file name should put that file at the
 * top, not three sections down under whatever the current screen can do.
 */
function useResults(query: string, items: PaletteItem[]): Section[] {
  return useMemo(() => {
    const trimmed = query.trim()
    const scored: ScoredItem[] = []

    for (const item of items) {
      const match = scoreCandidate(trimmed, item.label, item.keywords)
      if (match) scored.push({ item, match })
    }

    const sections: [CommandGroup, ScoredItem[]][] = []
    for (const group of COMMAND_GROUPS) {
      const members = scored.filter((entry) => entry.item.group === group)
      if (members.length === 0) continue

      if (trimmed === '') {
        // Untyped, the destination groups are unbounded lists of data. Show a
        // few so the palette explains what it can do, not the whole database.
        const previewable = group === 'Repositories' || group === 'Reviews' || group === 'Jump to file'
        sections.push([group, previewable ? members.slice(0, PREVIEW_PER_GROUP) : members])
        continue
      }

      members.sort((a, b) => b.match.score - a.match.score)
      sections.push([group, members])
    }

    if (trimmed !== '') {
      sections.sort(
        (a, b) => (b[1][0]?.match.score ?? -Infinity) - (a[1][0]?.match.score ?? -Infinity)
      )
    }

    // Trim to the row budget, and number the rows while doing it. The running
    // index is settled here rather than during render so that "which row is
    // the third one" is a fact about the results, not about draw order.
    const capped: Section[] = []
    let start = 0
    for (const [group, members] of sections) {
      if (start >= MAX_ROWS) break
      const kept = members.slice(0, MAX_ROWS - start)
      capped.push({ group, members: kept, start })
      start += kept.length
    }
    return capped
  }, [query, items])
}

export function CommandPalette({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The portal unmounts on close, so the body's data hooks - and the cost
          of scoring everything on every keystroke - exist only while it is up. */}
      <DialogContent
        showCloseButton={false}
        // Anchored near the top rather than centred: the list grows downward
        // as it fills, and a centred panel would jump on every keystroke.
        className="top-[12vh] max-w-xl translate-y-0 overflow-hidden p-0"
      >
        <PaletteBody onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useCommands()
  const destinations = useDestinations()

  const items = useMemo(
    () => [...commands.filter((command) => !command.hidden).map(toPaletteItem), ...destinations],
    [commands, destinations]
  )

  const sections = useResults(query, items)
  const flat = useMemo(() => sections.flatMap((section) => section.members), [sections])

  // A new query is a new list; keeping the old index would leave the highlight
  // on whatever happened to land in that slot. Adjusted here, during render,
  // rather than in an effect - React re-runs this pass before painting, so the
  // first frame of a new query is already highlighting its own first row.
  const [queryAtSelection, setQueryAtSelection] = useState(query)
  if (queryAtSelection !== query) {
    setQueryAtSelection(query)
    setSelected(0)
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = useCallback(
    (entry: ScoredItem | undefined) => {
      if (!entry || entry.item.disabled) return
      // Close first: a command that opens a dialog would otherwise open it
      // behind this one, and two stacked modals trap focus in the wrong place.
      onClose()
      entry.item.run()
    },
    [onClose]
  )

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    const count = flat.length

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        // Wrapping, because a list you can fall off the bottom of is a list you
        // have to look at to use.
        setSelected((index) => (count === 0 ? 0 : (index + 1) % count))
        break
      case 'ArrowUp':
        event.preventDefault()
        setSelected((index) => (count === 0 ? 0 : (index - 1 + count) % count))
        break
      case 'Home':
        event.preventDefault()
        setSelected(0)
        break
      case 'End':
        event.preventDefault()
        setSelected(Math.max(0, count - 1))
        break
      case 'Enter':
        event.preventDefault()
        choose(flat[selected])
        break
      case 'k':
        // The global layer stands down while a dialog is open, so the shortcut
        // that opened this has to be answered here to also close it.
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault()
          onClose()
        }
        break
      default:
        break
    }
  }

  return (
    <>
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Search for a command, a repository, a review, or a file in the open review.
      </DialogDescription>

      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search commands, repositories, reviews and files…"
          className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          aria-label="Search commands"
          aria-controls="command-palette-results"
          aria-activedescendant={flat[selected] ? `command-row-${flat[selected].item.id}` : undefined}
          role="combobox"
          aria-expanded
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div
        ref={listRef}
        id="command-palette-results"
        role="listbox"
        aria-label="Results"
        className="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain p-2"
      >
        {flat.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Nothing matches “{query.trim()}”.
          </p>
        )}

        {sections.map((section) => (
          <div key={section.group} className="mb-1 last:mb-0">
            <p className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
              {section.group}
            </p>
            {section.members.map((entry, offset) => {
              const index = section.start + offset
              return (
                <Row
                  key={entry.item.id}
                  entry={entry}
                  index={index}
                  active={index === selected}
                  onHover={setSelected}
                  onChoose={choose}
                />
              )
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[0.6875rem] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd binding="arrowup" />
          <Kbd binding="arrowdown" />
          to navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd binding="enter" />
          to run
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd binding="escape" />
          to close
        </span>
      </div>
    </>
  )
}

function Row({
  entry,
  index,
  active,
  onHover,
  onChoose
}: {
  entry: ScoredItem
  index: number
  active: boolean
  onHover: (index: number) => void
  onChoose: (entry: ScoredItem) => void
}) {
  const { item } = entry
  const Icon = item.icon

  return (
    <div
      id={`command-row-${item.id}`}
      data-index={index}
      role="option"
      aria-selected={active}
      aria-disabled={item.disabled}
      // Pointer rather than mouse, and hover moves the selection instead of
      // maintaining a second highlight: there is one selected row at a time,
      // whichever device moved it.
      onPointerMove={() => onHover(index)}
      onClick={() => onChoose(entry)}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm',
        active && 'bg-accent text-accent-foreground',
        item.disabled && 'cursor-default opacity-50'
      )}
    >
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">
        <Highlighted text={item.label} indices={entry.match.indices} />
      </span>
      {item.hint !== undefined && (
        <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground">
          {item.hint}
        </span>
      )}
      {item.keys !== undefined && <Kbd binding={item.keys} />}
      {active && item.keys === undefined && (
        <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </div>
  )
}

/** The label with the characters the query actually hit picked out. */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>

  const hit = new Set(indices)
  const parts: { text: string; match: boolean }[] = []

  for (let position = 0; position < text.length; position += 1) {
    const match = hit.has(position)
    const last = parts.at(-1)
    if (last && last.match === match) last.text += text[position]
    else parts.push({ text: text[position] as string, match })
  }

  return (
    <>
      {parts.map((part, partIndex) =>
        part.match ? (
          <mark key={partIndex} className="bg-transparent font-semibold text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={partIndex}>{part.text}</span>
        )
      )}
    </>
  )
}
