/**
 * The files-changed tab.
 *
 * The diff is taken from the merge base, so it shows what head added rather
 * than differences base picked up in the meantime - the same thing a pull
 * request shows.
 *
 * Which changes are shown is view state, not part of the review. Whether you
 * want the branch as it stands on disk, as it would arrive if pushed, or just
 * the edit you are making right now is a question you ask per visit, and each
 * answer is cached under its own SWR key so switching back is instant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  FileDiff,
  GitCompareArrows,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { formatStep } from '@/lib/keys'
import { plural } from '@/lib/format'
import { useHost } from '@/lib/host-scope'
import { useNarrow } from '@/lib/narrow'
import { useStoredFlag, useStoredPreference } from '@/lib/preferences'
import { revealElement } from '@/lib/reveal'
import { cn } from '@/lib/utils'
import { useRegisterCommands, type Command } from '@/features/commands/command-registry'
import type { DiffFocus } from '@/lib/router'
import { CommentThreadCard } from '../comments/comment-thread-card'
import { useCommentMutations, useReviewComments } from '../comments/use-comments'
import { ChangedFilesTree } from './changed-files-tree'
import { DiffFindBar, useDiffFind } from './diff-find-bar'
import { CompareErrorCard, NoWorktreeNotice, WorkingTreeBanner } from './compare-notices'
import { fileDomId, lineDomId } from './dom-ids'
import { DiffSnippet } from './diff-snippet'
import { DiffStat, FileDiffCard, type AnchoredThread } from './diff-view'
import {
  DEFAULT_DIFF_CHANGES,
  useEditors,
  useReviewDiff,
  useReviewedFiles
} from './use-reviews'
import { fileDiffDigest } from '@shared/diff-digest'
import { findAnchorFile, isInlineAnchor, resolveAnchor } from '@shared/comment-anchors'
import { threadSnippet } from '@shared/comment-snippets'
import type { DiffChanges, FileDiff as FileDiffData } from '@shared/git'
import { isSelfReview } from '@shared/schemas'
import type { CommentThread, Review } from '@shared/schemas'

/**
 * How far below the top of the scroller a file card may still sit and count as
 * the one being read.
 *
 * Larger than it looks like it needs to be, deliberately. `scrollIntoView` does
 * not land exactly on zero - measured, it settles several pixels short - and the
 * cards are separated by a gap of their own. A threshold tighter than that error
 * makes a stepped-to file read as "not reached yet", so the next press aims at
 * the same file again and stepping appears to stick. It only has to stay far
 * below the height of any card to be unambiguous, and it does.
 */
const TOP_EDGE_SLACK = 24

/**
 * The three views of a review's changes, in the order `u` steps through them.
 *
 * `all` first because it is the default and the one most visits want; then the
 * narrow view, which is the one you reach for repeatedly while making a small
 * edit on a long branch; then the committed-only view, which is the rarest.
 */
const CHANGES_CYCLE = ['all', 'uncommitted', 'committed'] as const

/** Left to right in the toggle: widening from the commits to the working tree. */
const CHANGES_OPTIONS = ['committed', 'all', 'uncommitted'] as const satisfies readonly DiffChanges[]

const CHANGES_LABELS: Record<DiffChanges, string> = {
  committed: 'Committed',
  all: 'All',
  uncommitted: 'Uncommitted'
}

/** Said in full wherever there is room for it - a tooltip, a command palette row. */
const CHANGES_DESCRIPTIONS: Record<DiffChanges, string> = {
  committed: 'Only what is committed on the head branch',
  all: 'Committed work with the worktree’s uncommitted changes folded in',
  uncommitted: 'Only the uncommitted changes in the worktree, against the head commit'
}

function nextChangesAfter(current: DiffChanges): DiffChanges {
  const index = CHANGES_CYCLE.indexOf(current)
  return CHANGES_CYCLE[(index + 1) % CHANGES_CYCLE.length] ?? 'all'
}

/**
 * The element a card actually scrolls inside.
 *
 * The app scrolls in a `<main>` that sits below the title bar, not in the
 * window, so a card resting at the top of the page still reports a viewport
 * offset of the title bar's height. Comparing against the scroller's own top
 * edge instead is what makes "which file is at the top" independent of whatever
 * chrome the shell puts above it.
 */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return document.documentElement
}

/**
 * How long a file step keeps counting as "where you are" for the next one.
 *
 * Stepping scrolls smoothly, which takes a few hundred milliseconds, and during
 * that time the layout still says you are on the file you are leaving. Someone
 * tapping `]` three times to move three files would otherwise be told "you are
 * on file 4" three times over and never get past file 5. Within this window the
 * step continues from where the last one was aimed; after it, the layout is
 * measured again, so scrolling by hand always resyncs.
 */
const STEP_CHAIN_MS = 800

/**
 * Place every line comment against the diff that is actually on screen.
 *
 * This runs here rather than in the main process on purpose. The reviewer can
 * switch which changes are shown at any moment, and each of those is a
 * genuinely different diff with different line numbers; a comment resolved
 * against another one would be pinned to a line the reader is not seeing. Doing
 * it against the rendered diff makes that impossible by construction - and it
 * reuses the same `resolveAnchor` the MCP server runs, so an agent and the
 * screen never disagree about where a comment sits.
 */
function anchorByFile(
  files: FileDiffData[],
  threads: CommentThread[]
): Map<string, AnchoredThread[]> {
  const byFile = new Map<string, AnchoredThread[]>()

  for (const thread of threads) {
    if (!isInlineAnchor(thread)) continue

    const file = findAnchorFile(files, thread.filePath)
    const anchored: AnchoredThread = {
      ...thread,
      anchor: resolveAnchor(file, {
        filePath: thread.filePath,
        side: thread.side,
        line: thread.line,
        startLine: thread.startLine,
        anchorText: thread.anchorText
      })
    }

    // Keyed by the file's current path so a thread left before a rename still
    // shows up on the card the reviewer is looking at.
    const key = file?.path ?? thread.filePath
    const existing = byFile.get(key)
    if (existing) existing.push(anchored)
    else byFile.set(key, [anchored])
  }

  return byFile
}

/**
 * Which file is nearest the top of the page, so the tree can point at it.
 *
 * An observer rather than a scroll handler: the browser answers "is this on
 * screen" without a layout read per frame, and the top band is narrowed with a
 * negative bottom margin so "current" means the file you are reading rather
 * than the last one that happens to be visible.
 */
function useActiveFile(paths: string[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  const key = paths.join('\n')

  useEffect(() => {
    const order = key === '' ? [] : key.split('\n')
    const visible = new Set<string>()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = entry.target.getAttribute('data-file-path')
          if (path === null) continue
          if (entry.isIntersecting) visible.add(path)
          else visible.delete(path)
        }
        setActive(order.find((path) => visible.has(path)) ?? null)
      },
      { rootMargin: '0px 0px -70% 0px' }
    )

    for (const path of order) {
      const element = document.getElementById(fileDomId(path))
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [key])

  return active
}

/**
 * Scroll to the line the URL asked for, and mark it while the reader finds it.
 *
 * The target may not be in the DOM yet - the diff is still rendering, or the
 * file card is collapsed and about to open - so this retries for a few frames
 * rather than firing once and missing. A line that never appears (the comment
 * was on code this diff does not contain) falls back to the file's card, which
 * is where such a thread is listed.
 */
function useFocusScroll(focus: DiffFocus | undefined, ready: boolean): DiffFocus | null {
  const [marked, setMarked] = useState<DiffFocus | null>(null)
  const key = focus ? `${focus.filePath}:${focus.side}:${focus.line}` : null

  useEffect(() => {
    if (!focus || !ready) return

    let frames = 0
    let frame = 0
    let clear = 0

    const find = (): void => {
      const line = document.getElementById(lineDomId(focus.filePath, focus.side, focus.line))
      const target = line ?? document.getElementById(fileDomId(focus.filePath))

      if (target) {
        target.scrollIntoView({ block: line ? 'center' : 'start', behavior: 'smooth' })
        if (line) {
          setMarked(focus)
          // Long enough to catch the eye after a smooth scroll, short enough
          // that the diff is not left permanently highlighted.
          clear = window.setTimeout(() => setMarked(null), 2500)
        }
        return
      }
      // ~30 frames is half a second of waiting for a card to open.
      if (frames++ < 30) frame = requestAnimationFrame(find)
    }

    frame = requestAnimationFrame(find)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(clear)
      setMarked(null)
    }
    // `key` stands in for the focus object, which is rebuilt on every route read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready])

  return marked
}

/**
 * Whether the file list is showing, and what picking a file in it does.
 *
 * Two layouts behind one button. On a wide window the list is a sidebar
 * *beside* the diff: it is remembered between visits, and clicking a file
 * scrolls the diff along behind it, so the list is a place to keep your bearings
 * from. On a narrow one there is no room for both, so it is the screen
 * *instead of* the diff, and clicking a file is a navigation - the list goes
 * away and the diff arrives at that file. Same button, same tree, two meanings
 * that the width picks between.
 *
 * The two get separate state deliberately. They answer different questions -
 * "do I want a sidebar" against "am I looking at the index right now" - and one
 * flag for both would carry a remembered `true` off the desktop and open every
 * review on a phone at its table of contents rather than at the diff.
 */
function useFilesLayout(): {
  narrow: boolean
  listOpen: boolean
  setListOpen: (open: boolean) => void
  selectFile: (path: string) => void
} {
  const narrow = useNarrow()
  const [treeOpen, setTreeOpen] = useStoredFlag('files-tree', true)
  const [listScreen, setListScreen] = useState(false)
  // A file to scroll to once the diff is back on screen. The scroll cannot
  // happen in the click handler: on a narrow window the diff is still the
  // hidden half at that moment, and `scrollIntoView` on a `display: none`
  // element silently does nothing. A ref rather than state, and an effect on
  // the screen that reveals it rather than on the target: what is being waited
  // for is the diff being painted, and the ref is only the note of where to go
  // when it is - nothing renders differently for it.
  const pending = useRef<string | null>(null)

  useEffect(() => {
    const path = pending.current
    if (path === null) return
    pending.current = null
    // No `smooth`: the diff has only just appeared, and animating a scroll
    // through content the reader has not seen yet reads as a glitch rather
    // than as movement.
    document.getElementById(fileDomId(path))?.scrollIntoView({ block: 'start' })
  }, [listScreen])

  const selectFile = useCallback(
    (path: string) => {
      if (narrow) {
        pending.current = path
        setListScreen(false)
        return
      }
      document
        .getElementById(fileDomId(path))
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
    [narrow]
  )

  return {
    narrow,
    listOpen: narrow ? listScreen : treeOpen,
    setListOpen: narrow ? setListScreen : setTreeOpen,
    selectFile
  }
}

export function ReviewFilesTab({ review, focus }: { review: Review; focus?: DiffFocus }) {
  const host = useHost()
  const [changes, setChanges] = useState<DiffChanges>(DEFAULT_DIFF_CHANGES)
  const [editorId, setEditorId] = useStoredPreference('editor', null)
  const [openError, setOpenError] = useState<unknown>(null)
  const { narrow, listOpen, setListOpen, selectFile } = useFilesLayout()
  const { data, error, isLoading, isRefreshing, refresh } = useReviewDiff(review.id, changes)
  const { threads } = useReviewComments(review.id)
  const mutations = useCommentMutations()
  const localEditors = useEditors()
  /**
   * No editors on a review that belongs to another machine, and therefore no
   * open-in-editor buttons and no editor picker.
   *
   * `reviews.filePath` answers with a path on the *host*, and `openInEditor` is
   * this machine's shell - so the two halves that M1 deliberately kept separate
   * would be joined across a network and hand a Mac editor a path only WSL has.
   * The honest form of that is an editor list with nothing in it, which every
   * control below already knows how to render: this is the same shape a browser
   * tab has had since M3.
   */
  const editors = host === undefined ? localEditors : undefined

  const threadsByFile = useMemo(
    () => anchorByFile(data?.files ?? [], threads),
    [data?.files, threads]
  )

  /** Threads keyed under a path that no file in the current diff carries. */
  const orphanedFiles = useMemo(() => {
    const present = new Set((data?.files ?? []).map((file) => file.path))
    return [...threadsByFile].filter(([path]) => !present.has(path))
  }, [data?.files, threadsByFile])

  // One array identity per diff, so the search below is not re-run against a
  // freshly built list on every keystroke elsewhere on the screen.
  const files = useMemo(() => data?.files ?? [], [data?.files])
  const paths = useMemo(() => files.map((file) => file.path), [files])
  const activePath = useActiveFile(paths)
  const find = useDiffFind(files)

  /**
   * The fingerprint of every file *as it is being shown*, which is what a
   * reviewed mark is checked against.
   *
   * Computed here rather than in the main process because the diff on screen is
   * the only thing anyone can claim to have read - and each view of the changes
   * produces a different one. See `shared/diff-digest.ts`.
   */
  const digestByPath = useMemo(
    () => new Map((data?.files ?? []).map((file) => [file.path, fileDiffDigest(file)])),
    [data?.files]
  )

  const { digests: reviewedDigests, setReviewed } = useReviewedFiles(review.id)

  /** Marks that still describe the code on screen. */
  const reviewedPaths = useMemo(() => {
    const marked = new Set<string>()
    for (const [path, digest] of digestByPath) {
      if (reviewedDigests.get(path) === digest) marked.add(path)
    }
    return marked
  }, [digestByPath, reviewedDigests])

  /**
   * Marks that no longer do: the file was read, and then it changed.
   *
   * Kept apart from the plain unread files rather than folded in with them,
   * because it is the more useful of the two states - these are the files where
   * something arrived after the reviewer had already been through them.
   */
  const changedSincePaths = useMemo(() => {
    const stale = new Set<string>()
    for (const [path, digest] of digestByPath) {
      const stored = reviewedDigests.get(path)
      if (stored !== undefined && stored !== digest) stale.add(path)
    }
    return stale
  }, [digestByPath, reviewedDigests])

  const markReviewed = useCallback(
    (path: string, next: boolean): void => {
      const digest = digestByPath.get(path)
      // A file that is not in this diff cannot be marked against it.
      if (digest === undefined) return
      void setReviewed(path, next ? digest : null)
    },
    [digestByPath, setReviewed]
  )

  /** What the tree shows next to a file: comments still waiting on someone. */
  const unresolvedByFile = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [path, fileThreads] of threadsByFile) {
      const unresolved = fileThreads.filter((thread) => thread.resolvedAt === null).length
      if (unresolved > 0) counts.set(path, unresolved)
    }
    return counts
  }, [threadsByFile])

  /**
   * Opening a file, and the reason there is a second name for it below.
   *
   * `FileActions` in `diff-view.tsx` decides whether to draw the button from
   * whether it was given a *callback*, not from whether there is an editor
   * list - so leaving the list empty for a remote host turned off the picker
   * and left the button, and pressing it asked *this* install for
   * `reviews.filePath` of a review id that means something else over there.
   * Found by pressing it against `pc-wsl`, which is the one failure shape this
   * slice set out to avoid: doing something plausible to the wrong file.
   */
  const openLocally = useCallback(
    (path: string, line: number) => {
      setOpenError(null)
      api.reviews
        .openInEditor({
          id: review.id,
          path,
          changes,
          line,
          ...(editorId === null ? {} : { editorId })
        })
        .catch(setOpenError)
    },
    [review.id, changes, editorId]
  )

  // Undefined on a review that belongs to another machine - see the note above.
  const openInEditor = host === undefined ? openLocally : undefined

  const marked = useFocusScroll(focus, !isLoading && data !== undefined)

  /**
   * Step through the diff one file at a time.
   *
   * Where the reader currently is comes from the layout, read at the moment the
   * key is pressed, rather than from the observer that drives the file tree's
   * highlight. The observer reports asynchronously and has usually said nothing
   * at all on arrival, which made the first press of `]` scroll to the file
   * already at the top - that is, do nothing. Measuring instead is one cheap
   * layout read on a keystroke, and it is never a frame behind.
   */
  const lastStep = useRef<{ index: number; at: number } | null>(null)

  /**
   * The last card whose top edge has passed the top of the scroller is the one
   * being read; everything after it is still below.
   *
   * Shared by stepping and by the reviewed shortcut, so "the file you are on"
   * means the same thing whichever key is pressed.
   */
  const currentFile = useCallback((): number => {
    let current = 0
    let edge: number | null = null
    for (const [index, path] of paths.entries()) {
      const element = document.getElementById(fileDomId(path))
      if (element === null) continue
      edge ??= scrollParent(element).getBoundingClientRect().top
      if (element.getBoundingClientRect().top - edge > TOP_EDGE_SLACK) break
      current = index
    }
    return current
  }, [paths])

  const stepFile = useCallback(
    (delta: number): void => {
      if (paths.length === 0) return

      const now = Date.now()
      const pending = lastStep.current
      const current =
        pending !== null && now - pending.at < STEP_CHAIN_MS ? pending.index : currentFile()

      const next = Math.min(paths.length - 1, Math.max(0, current + delta))
      lastStep.current = { index: next, at: now }
      const path = paths[next]
      if (path !== undefined) revealElement(fileDomId(path))
    },
    [paths, currentFile]
  )

  /**
   * Tick the file being read off, or take the tick back.
   *
   * `v` because that is the key GitHub uses for the same gesture, and muscle
   * memory is most of the value of a shortcut like this one.
   */
  const toggleCurrentReviewed = useCallback((): void => {
    const path = paths[currentFile()]
    if (path === undefined) return
    markReviewed(path, !reviewedPaths.has(path))
  }, [paths, currentFile, markReviewed, reviewedPaths])

  const canReadWorktree = data?.workingTree != null
  const nextChanges = nextChangesAfter(changes)

  useRegisterCommands(
    useMemo<Command[]>(
      () => [
        {
          id: 'files:next',
          label: 'Next file',
          group: 'Files changed',
          keys: ']',
          keywords: 'down scroll',
          icon: ArrowDown,
          disabled: paths.length === 0,
          run: () => stepFile(1)
        },
        {
          id: 'files:previous',
          label: 'Previous file',
          group: 'Files changed',
          keys: '[',
          keywords: 'up scroll back',
          icon: ArrowUp,
          disabled: paths.length === 0,
          run: () => stepFile(-1)
        },
        {
          id: 'files:tree',
          label: listOpen ? 'Hide the file list' : 'Show the file list',
          group: 'Files changed',
          keys: 't',
          keywords: 'tree sidebar panel toggle',
          icon: listOpen ? PanelLeftClose : PanelLeft,
          disabled: paths.length === 0,
          run: () => setListOpen(!listOpen)
        },
        {
          id: 'files:uncommitted',
          label: `Show ${CHANGES_LABELS[nextChanges].toLowerCase()} changes`,
          group: 'Files changed',
          keys: 'u',
          keywords: 'working tree dirty staged unstaged untracked committed only',
          icon: GitCompareArrows,
          // Two of the three views need a worktree; without one there is only
          // the committed diff, and stepping between identical views is noise.
          disabled: !canReadWorktree,
          run: () => setChanges(nextChanges)
        },
        {
          id: 'files:reviewed',
          label:
            activePath !== null && reviewedPaths.has(activePath)
              ? 'Clear the reviewed mark on this file'
              : 'Mark this file as reviewed',
          group: 'Files changed',
          keys: 'v',
          keywords: 'viewed read seen done tick check off',
          icon: CheckCheck,
          disabled: paths.length === 0,
          run: toggleCurrentReviewed
        },
        {
          id: 'files:find',
          label: 'Find in the diff',
          group: 'Files changed',
          keys: 'mod+f',
          keywords: 'search text highlight grep locate',
          icon: Search,
          disabled: paths.length === 0,
          run: find.show
        },
        // Only while the bar is up. The help sheet lists what works here, and
        // "next match" with nothing being searched for is not one of them.
        ...(find.open
          ? [
              {
                id: 'files:find-next',
                label: 'Next match',
                group: 'Files changed',
                keys: 'mod+g',
                keywords: 'search find again forward',
                icon: ChevronDown,
                disabled: find.matches.length === 0,
                run: () => find.step(1)
              } satisfies Command,
              {
                id: 'files:find-previous',
                label: 'Previous match',
                group: 'Files changed',
                keys: 'mod+shift+g',
                keywords: 'search find again back',
                icon: ChevronUp,
                disabled: find.matches.length === 0,
                run: () => find.step(-1)
              } satisfies Command,
              {
                id: 'files:find-close',
                label: 'Close the find bar',
                group: 'Files changed',
                keys: 'escape',
                icon: X,
                // Escape is answered by the field itself while it has the
                // focus; this is for the reader who has clicked back into the
                // diff and still expects it to put the search away.
                hidden: true,
                run: find.close
              } satisfies Command
            ]
          : []),
        {
          id: 'files:refresh',
          label: 'Refresh the diff',
          group: 'Files changed',
          keys: 'r',
          keywords: 'reload re-read disk git',
          icon: RefreshCw,
          run: () => void refresh()
        }
      ],
      [
        paths.length,
        stepFile,
        listOpen,
        setListOpen,
        nextChanges,
        canReadWorktree,
        refresh,
        activePath,
        reviewedPaths,
        toggleCurrentReviewed,
        find
      ]
    )
  )

  if (isLoading) return <LoadingState />

  if (error !== undefined) {
    return (
      <Card className="flex flex-col items-center gap-3 border-destructive/40 px-6 py-10 text-center">
        <div className="rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertCircle className="size-6" />
        </div>
        <p className="max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
        <Button variant="outline" onClick={() => void refresh()}>
          <RefreshCw />
          Try again
        </Button>
      </Card>
    )
  }

  if (!data) return null
  if (data.error !== null || data.base.error !== null || data.head.error !== null) {
    return <CompareErrorCard compare={data} />
  }

  const hasWorktree = data.workingTree !== null
  const selfReview = isSelfReview(review)

  return (
    <div className="flex flex-col gap-3">
      {/* Both groups wrap, not just the row between them. A row of controls
          that only wraps as a block runs off a narrow window and takes the
          controls at its end out of reach entirely - there is no horizontal
          scroll here to reveal them, so `Refresh` and the view toggle were
          simply gone below about 700px. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {plural(data.files.length, 'file')} changed
          </p>
          <DiffStat additions={data.additions} deletions={data.deletions} />
          {/* Only once there is progress to report; "0 of 12 reviewed" is a
              statement of the obvious taking up room next to the file count. */}
          {reviewedPaths.size > 0 && (
            <p
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              title="Files you have marked as reviewed. A mark clears itself when its file changes."
            >
              <CheckCheck className="size-4 text-success" />
              {reviewedPaths.size} of {data.files.length} reviewed
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {data.files.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={find.show}
              title={`Find in the diff (${formatStep('mod+f')})`}
              aria-expanded={find.open}
            >
              <Search />
              Find
            </Button>
          )}

          {data.files.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setListOpen(!listOpen)}
              title={listOpen ? 'Hide the file list' : 'Show the file list'}
              aria-pressed={listOpen}
            >
              {listOpen ? <PanelLeftClose /> : <PanelLeft />}
              Files
            </Button>
          )}

          {/* Only worth asking when the machine actually has a choice. */}
          {editors !== undefined && editors.editors.length > 1 && (
            <Select
              items={editors.editors.map((editor) => ({
                value: editor.id,
                label: editor.label
              }))}
              value={editorId ?? editors.defaultId ?? ''}
              onValueChange={(next) => setEditorId(typeof next === 'string' ? next : null)}
            >
              <SelectTrigger
                className="h-8 w-auto min-w-32 max-w-48 text-xs"
                title="Which editor the open-file buttons use"
              >
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                {editors.editors.map((editor) => (
                  <SelectItem key={editor.id} value={editor.id}>
                    {editor.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <ChangesToggle
            changes={changes}
            onChange={setChanges}
            hasWorktree={hasWorktree}
            headRef={review.headRef}
            selfReview={selfReview}
          />

          <Button variant="ghost" size="sm" onClick={() => void refresh()} title="Re-read from disk">
            <RefreshCw className={isRefreshing ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {find.open && <DiffFindBar find={find} />}

      {changes !== 'committed' && data.workingTree?.isDirty && (
        <WorkingTreeBanner workingTree={data.workingTree} />
      )}
      {!hasWorktree && <NoWorktreeNotice headRef={review.headRef} />}
      {changes === 'uncommitted' && hasWorktree && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          Measured against <span className="font-mono">{review.headRef}</span>, so everything
          already committed on the branch is hidden.
        </p>
      )}
      {changes === 'committed' && hasWorktree && data.workingTree?.isDirty && (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          Uncommitted changes are being left out of this diff. Switch to All or Uncommitted to see
          them.
        </p>
      )}

      {/* Threads whose file has left the diff entirely - it was reverted, or
          the base ref moved on and absorbed the change. Nothing below would
          render them, and a discussion that silently disappears because the
          code moved is exactly the failure this app should not have. */}
      {orphanedFiles.length > 0 && (
        <Card className="flex flex-col gap-2 border-warning/40 p-3">
          <p className="text-xs text-muted-foreground">
            {plural(orphanedFiles.length, 'file')} with comments{' '}
            {orphanedFiles.length === 1 ? 'is' : 'are'} no longer in this diff.
          </p>
          {orphanedFiles.map(([path, fileThreads]) => (
            <div key={path} className="flex flex-col gap-3">
              {fileThreads.map((thread) => {
                // No file to read the code from, so this is the stored snapshot
                // or nothing at all.
                const snippet = threadSnippet(thread, thread.anchor, undefined)
                const hasSnippet = snippet !== null && snippet.lines.length > 0

                return (
                  <div key={thread.id} className="flex flex-col gap-2">
                    {hasSnippet ? (
                      <DiffSnippet {...snippet} />
                    ) : (
                      <p className="font-mono text-xs text-muted-foreground">{path}</p>
                    )}
                    <CommentThreadCard
                      thread={thread}
                      mutations={mutations}
                      anchorState={thread.anchor.state}
                      location={
                        !hasSnippet && thread.line !== null ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            was line {thread.line}
                          </span>
                        ) : null
                      }
                    />
                  </div>
                )
              })}
            </div>
          ))}
        </Card>
      )}

      {data.files.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
          <div className="rounded-full bg-muted p-3 text-muted-foreground">
            <FileDiff className="size-6" />
          </div>
          <h3 className="font-medium">No changes</h3>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {changes === 'uncommitted' && !hasWorktree ? (
              <>
                No worktree has <span className="font-mono">{review.headRef}</span> checked out, so
                there is no uncommitted work to show.
              </>
            ) : changes === 'uncommitted' || (selfReview && changes === 'all') ? (
              // A self-review has no committed range at all, so "all" and
              // "uncommitted" are the same view of it and read the same way.
              <>
                Nothing is uncommitted on <span className="font-mono">{review.headRef}</span> right
                now. Edit a file and refresh — it will show up here.
              </>
            ) : selfReview ? (
              <>
                This review is <span className="font-mono">{review.headRef}</span> against itself, so
                it holds only uncommitted work. Switch to All or Uncommitted to see it.
              </>
            ) : (
              <>
                <span className="font-mono">{review.headRef}</span> has nothing that{' '}
                <span className="font-mono">{review.baseRef}</span> does not already have.
              </>
            )}
          </p>
        </Card>
      ) : (
        // `items-start` so the tree can stick to the top of the viewport while
        // the diff beside it scrolls; a stretched column would never stick.
        <div className="flex items-start gap-4">
          {listOpen && (
            // Two shapes, one element. Wide: a sticky sidebar that keeps its
            // own place while the diff scrolls past it, wider still where there
            // is room, because every column the tree gains is a file name that
            // fits on one line instead of wrapping onto two. Narrow: the whole
            // width, in the flow, scrolling with the page - there is no diff
            // beside it to stay level with, and a 224px column of wrapped names
            // is not a file list anybody can read.
            <aside
              className={cn(
                'rounded-lg border border-border bg-card/50 px-1',
                narrow
                  ? 'w-full'
                  : 'sticky top-2 max-h-[calc(100dvh-6rem)] w-56 shrink-0 overflow-y-auto xl:w-64 2xl:w-72'
              )}
            >
              <ChangedFilesTree
                files={data.files}
                activePath={activePath}
                unresolvedByFile={unresolvedByFile}
                reviewedPaths={reviewedPaths}
                changedSincePaths={changedSincePaths}
                onSelect={selectFile}
              />
            </aside>
          )}

          {/* Hidden rather than unmounted on the narrow layout: going to the
              list and back is a step a reader takes often, and unmounting
              would throw away every hunk they had unfolded to get here. */}
          <div
            className={cn(
              'min-w-0 flex-1 flex-col gap-2',
              narrow && listOpen ? 'hidden' : 'flex'
            )}
          >
            {data.files.map((file) => (
              <div
                key={`${file.oldPath ?? ''}:${file.path}`}
                id={fileDomId(file.path)}
                data-file-path={file.path}
                className="scroll-mt-2"
              >
                <FileDiffCard
                  // Remounted when the view changes: that is a different diff
                  // with different line numbers, so anything unfolded against
                  // the old one has to go.
                  key={changes}
                  file={file}
                  // Only the card that owns the line hears about it, so one
                  // arriving link cannot light up the same number in every file.
                  focus={focus?.filePath === file.path ? focus : undefined}
                  search={find.searchFor(file.path)}
                  marked={marked?.filePath === file.path ? marked : undefined}
                  reviewed={{
                    isReviewed: reviewedPaths.has(file.path),
                    hasChangedSince: changedSincePaths.has(file.path),
                    onChange: (next) => markReviewed(file.path, next)
                  }}
                  comments={{
                    reviewId: review.id,
                    threads: threadsByFile.get(file.path) ?? [],
                    mutations,
                    changes
                  }}
                  source={{
                    reviewId: review.id,
                    changes,
                    editorId,
                    editorLabel:
                      editors?.editors.find(
                        (editor) => editor.id === (editorId ?? editors.defaultId)
                      )?.label ?? null,
                    onOpenInEditor: openInEditor
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {openError !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(openError)}
        </p>
      )}
    </div>
  )
}

/**
 * Which of the three views of the changes is on screen.
 *
 * A segmented control rather than the switch this replaced: the three views are
 * one question with three answers, and a switch can only ask a question with
 * two. All three stay visible so the narrow view is discoverable - the whole
 * point of it is that you reach for it mid-edit, without having gone looking
 * through a menu first.
 *
 * With no worktree holding the head there is only ever the committed diff, so
 * the other two are disabled rather than hidden: a control that changes shape
 * between reviews is harder to learn than one that greys out and says why.
 */
function ChangesToggle({
  changes,
  onChange,
  hasWorktree,
  headRef,
  selfReview
}: {
  changes: DiffChanges
  onChange: (next: DiffChanges) => void
  hasWorktree: boolean
  headRef: string
  selfReview: boolean
}) {
  return (
    <div
      role="group"
      aria-label="Which changes to show"
      className="flex items-center rounded-md border border-border p-0.5"
    >
      {CHANGES_OPTIONS.map((option) => {
        const needsWorktree = option !== 'committed'
        const disabled = needsWorktree && !hasWorktree
        // A self-review's committed range is empty by construction, so say that
        // rather than let the button look broken when it shows nothing.
        const title = disabled
          ? `No worktree has ${headRef} checked out, so there is nothing uncommitted to show`
          : option === 'committed' && selfReview
            ? `This review is ${headRef} against itself, so it holds no committed changes`
            : CHANGES_DESCRIPTIONS[option]

        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            disabled={disabled}
            aria-pressed={changes === option}
            title={title}
            className={
              'rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
              (changes === option
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {CHANGES_LABELS[option]}
          </button>
        )
      })}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading changes">
      {[0, 1].map((index) => (
        <Card key={index} className="overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2">
            <Skeleton className="size-4" />
            <Skeleton className="h-4 w-56" />
            <div className="flex-1" />
            <Skeleton className="h-4 w-14" />
          </div>
          <div className="space-y-1 border-t border-border p-3">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </Card>
      ))}
    </div>
  )
}
