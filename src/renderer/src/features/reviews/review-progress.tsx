/**
 * How far through the review the reader is: where they have scrolled to, and
 * how much of it they have ticked off.
 *
 * One slot per file, every slot the same width. The scrollbar already says how
 * far down the *lines* you are, and on a branch that regenerated a lock file it
 * says you are nowhere: the lock file is most of the page. This says you are on
 * file three of five, which is the question a reviewer is actually asking.
 *
 * Three things on one track:
 *  - green slots for files marked reviewed, amber for files that changed after
 *    they were marked - the same colours the file list uses for both;
 *  - a lighter wash up to the marker, for what has been scrolled past;
 *  - the marker itself, which moves through a file as it is read.
 *
 * The strip is its own component with its own scroll listener on purpose. The
 * reading position changes every frame while the page moves, and that state
 * living in the files tab would re-render the tab - and ask four hundred file
 * cards whether they had changed - sixty times a second.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject
} from 'react'
import { Check, CheckCheck, History, PartyPopper } from 'lucide-react'
import { FileStatusIcon } from './diff-view'
import { fileDomId } from './dom-ids'
import { FilePath } from './file-path'
import { fileAt, markRuns, readingPosition, TOP_EDGE_SLACK } from './review-progress-model'
import { scrollParent } from '@/lib/scroll-parent'
import { cn } from '@/lib/utils'
import type { FileDiff } from '@shared/git'

/**
 * Up to how many files the slots are drawn with a gap between them. Past this
 * a gap is wider than the slot it separates, and the strip reads as a comb.
 */
const SEPARATE_SLOTS_UP_TO = 80

/** How long a newly ticked slot glows for; matches `review-tick` in index.css. */
const TICK_GLOW_MS = 900

export interface ReviewProgressProps {
  files: readonly FileDiff[]
  reviewedPaths: ReadonlySet<string>
  changedSincePaths: ReadonlySet<string>
  /** Take the reader to a file - the same thing picking it in the file list does. */
  onSelect: (path: string) => void
}

const percent = (part: number, whole: number): string =>
  `${whole === 0 ? 0 : (part / whole) * 100}%`

/**
 * The reading position, in files, kept up to date while the page scrolls.
 *
 * Read on the next frame after a scroll rather than on the scroll itself, so a
 * fast flick that fires a dozen events between paints costs one measurement.
 * Also re-read when the column of cards changes size: ticking a file off folds
 * it, which moves everything below without the scroller moving at all.
 */
function useReadingPosition(
  paths: readonly string[],
  strip: RefObject<HTMLElement | null>
): number {
  const [position, setPosition] = useState(0)

  useEffect(() => {
    const anchor = strip.current
    if (anchor === null || paths.length === 0) return

    const scroller = scrollParent(anchor)
    const isDocument = scroller === document.documentElement
    let frame = 0

    const measure = (): void => {
      frame = 0
      // The line a card comes to rest on when it is stepped or jumped to - the
      // top of the scroller plus the cards' `scroll-mt`, which clears the
      // pinned strip - so the file a jump lands on is the file this names.
      const firstPath = paths[0]
      const firstCard =
        firstPath === undefined ? null : document.getElementById(fileDomId(firstPath))
      const margin =
        firstCard === null ? 0 : parseFloat(getComputedStyle(firstCard).scrollMarginTop) || 0
      const top = isDocument ? 0 : scroller.getBoundingClientRect().top
      const line = top + margin + TOP_EDGE_SLACK
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      const next = readingPosition(
        paths.length,
        line,
        (index) => {
          const path = paths[index]
          const card = path === undefined ? null : document.getElementById(fileDomId(path))
          if (card === null) return null
          const box = card.getBoundingClientRect()
          return { top: box.top, height: box.height }
        },
        atEnd
      )
      // Rounded to a few thousandths of a file, so a scroll that moves nothing
      // anyone could see does not re-render the strip either.
      setPosition(Math.round(next * 1000) / 1000)
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }

    measure()
    const target: HTMLElement | Window = isDocument ? window : scroller
    target.addEventListener('scroll', schedule, { passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(scroller)
    const firstPath = paths[0]
    const column =
      firstPath === undefined ? null : document.getElementById(fileDomId(firstPath))?.parentElement
    if (column) resize.observe(column)

    return () => {
      cancelAnimationFrame(frame)
      target.removeEventListener('scroll', schedule)
      resize.disconnect()
    }
  }, [paths, strip])

  return position
}

/**
 * Files ticked off in the last moment, so their slots can light up.
 *
 * Only additions, and only ones made while the strip is on screen - a review
 * opened with sixty files already marked does not greet the reader with sixty
 * flashes.
 */
function useJustReviewed(reviewedPaths: ReadonlySet<string>): ReadonlySet<string> {
  const previous = useRef(reviewedPaths)
  const [glowing, setGlowing] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const before = previous.current
    previous.current = reviewedPaths
    const added = [...reviewedPaths].filter((path) => !before.has(path))
    if (added.length === 0 || added.length > 3) return

    setGlowing((current) => new Set([...current, ...added]))
    const timer = window.setTimeout(() => {
      setGlowing((current) => {
        const next = new Set(current)
        for (const path of added) next.delete(path)
        return next
      })
    }, TICK_GLOW_MS)
    return () => window.clearTimeout(timer)
  }, [reviewedPaths])

  return glowing
}

export const ReviewProgress = memo(function ReviewProgress({
  files,
  reviewedPaths,
  changedSincePaths,
  onSelect
}: ReviewProgressProps) {
  const paths = useMemo(() => files.map((file) => file.path), [files])
  const count = paths.length
  const strip = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const position = useReadingPosition(paths, strip)
  const glowing = useJustReviewed(reviewedPaths)
  const [hovered, setHovered] = useState<number | null>(null)

  const runs = useMemo(
    () => markRuns(paths, reviewedPaths, changedSincePaths),
    [paths, reviewedPaths, changedSincePaths]
  )

  // Counted against the files on screen, not against the stored marks: a mark
  // for a file that has since left the diff is nothing left to do.
  const reviewed = reviewedPaths.size
  const done = count > 0 && reviewed === count
  const current = Math.min(count, Math.floor(position) + 1)
  // Never "0%" once something is ticked, and never "100%" until everything is:
  // three files into four hundred is a start, and the number should say so.
  const share =
    reviewed === 0 || count === 0
      ? 0
      : done
        ? 100
        : Math.min(99, Math.max(1, Math.round((reviewed / count) * 100)))

  function pointAt(event: MouseEvent<HTMLDivElement>): number {
    const box = event.currentTarget.getBoundingClientRect()
    return fileAt(count, event.clientX - box.left, box.width)
  }

  const hoveredFile = hovered === null ? undefined : files[hovered]

  return (
    <div
      ref={strip}
      className="flex items-center gap-3 rounded-lg border border-border bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur max-sm:gap-2 max-sm:px-2"
    >
      {/* The track. A pointer target as a shortcut - the file list and `[`/`]`
          are the ways in that do not need one - so it is a progress bar to
          assistive technology, and the jump is a bonus for a mouse. */}
      <div
        ref={track}
        role="progressbar"
        aria-label="Files reviewed"
        aria-valuemin={0}
        aria-valuemax={count}
        aria-valuenow={reviewed}
        aria-valuetext={`${reviewed} of ${count} files reviewed; reading file ${current}`}
        className="relative h-4.5 min-w-16 flex-1 cursor-pointer"
        onPointerMove={(event) => setHovered(pointAt(event))}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => {
          const path = paths[pointAt(event)]
          if (path !== undefined) onSelect(path)
        }}
      >
        <div
          className={cn(
            'absolute inset-x-0 top-1 h-2.5 overflow-hidden rounded-full bg-muted',
            // Once, when the last file is ticked off. `motion-safe` so a
            // reader who has asked for less movement gets the colour alone.
            done && 'motion-safe:animate-[review-done_1.1s_ease-out_1]'
          )}
        >
          {/* Scrolled past. Under the marks, so a reviewed file reads as
              reviewed whichever side of the marker it is on. */}
          <div
            className="absolute inset-y-0 left-0 bg-foreground/15"
            style={{ width: percent(position, count) }}
          />

          {runs.map((run) => (
            <div
              key={`${run.mark}-${run.start}`}
              className={cn(
                'absolute inset-y-0',
                run.mark === 'reviewed' ? 'bg-success' : 'bg-warning'
              )}
              style={{ left: percent(run.start, count), width: percent(run.length, count) }}
            />
          ))}

          {[...glowing].map((path) => {
            const index = paths.indexOf(path)
            if (index === -1) return null
            return (
              <div
                key={path}
                className="absolute inset-y-0 bg-success motion-safe:animate-[review-tick_0.9s_ease-out_forwards]"
                style={{ left: percent(index, count), width: percent(1, count) }}
              />
            )
          })}

          {/* The gaps between slots, drawn over everything as one repeating
              background rather than one element per file. */}
          {count > 1 && count <= SEPARATE_SLOTS_UP_TO && (
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'linear-gradient(to right, transparent calc(100% - 2px), var(--color-card) 0)',
                backgroundSize: `${100 / count}% 100%`
              }}
            />
          )}

          {hovered !== null && (
            <div
              aria-hidden
              className="absolute inset-y-0 bg-foreground/20"
              style={{ left: percent(hovered, count), width: percent(1, count) }}
            />
          )}
        </div>

        {/* Where the reader is. Taller than the track so it can be found on a
            bar that is entirely green. */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 h-4.5 w-1 -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-card)]"
          style={{ left: percent(position, count) }}
        />

        {hoveredFile !== undefined && hovered !== null && (
          <HoverCard
            file={hoveredFile}
            index={hovered}
            count={count}
            isReviewed={reviewedPaths.has(hoveredFile.path)}
            hasChangedSince={changedSincePaths.has(hoveredFile.path)}
          />
        )}
      </div>

      <p className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        <span className="max-sm:hidden">
          File {current} of {count}
        </span>
        {done ? (
          <span className="flex items-center gap-1 font-medium text-success">
            <PartyPopper className="size-3.5" />
            All {count} reviewed
          </span>
        ) : (
          <span
            className={cn('flex items-center gap-1', reviewed > 0 && 'text-foreground')}
            title="Files you have marked as reviewed. A mark clears itself when its file changes."
          >
            <CheckCheck className={cn('size-3.5', reviewed > 0 && 'text-success')} />
            {/* Keyed on the count so it rises in afresh each time it goes up. */}
            <span key={reviewed} className="motion-safe:animate-[rise-in_0.3s_ease-out]">
              {reviewed}/{count}
            </span>
            <span className="text-muted-foreground">· {share}%</span>
          </span>
        )}
      </p>
    </div>
  )
})

/**
 * Which file a point on the track is, before the click that goes there.
 *
 * Kept to its slot's side of the track near either end, so a file at the edge
 * of the strip does not push its own label off the window.
 */
function HoverCard({
  file,
  index,
  count,
  isReviewed,
  hasChangedSince
}: {
  file: FileDiff
  index: number
  count: number
  isReviewed: boolean
  hasChangedSince: boolean
}) {
  const centre = (index + 0.5) / count
  const align = centre < 0.2 ? 'start' : centre > 0.8 ? 'end' : 'middle'

  return (
    <div
      className={cn(
        'pointer-events-none absolute top-full z-30 mt-2 flex w-max max-w-[min(28rem,80vw)] items-start gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-card-foreground shadow-md',
        align === 'middle' && '-translate-x-1/2',
        align === 'end' && '-translate-x-full'
      )}
      style={{ left: percent(index + (align === 'start' ? 0 : align === 'end' ? 1 : 0.5), count) }}
    >
      {isReviewed ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
      ) : hasChangedSince ? (
        <History className="mt-0.5 size-3.5 shrink-0 text-warning" />
      ) : (
        <FileStatusIcon status={file.status} className="mt-0.5 size-3.5" />
      )}
      <span className="min-w-0 font-mono">
        <FilePath path={file.path} />
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {index + 1}/{count}
      </span>
    </div>
  )
}
