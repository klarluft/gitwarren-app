/**
 * The file column beside a diff or a file, and the grip that widens it.
 *
 * Both review tabs put a list of files down the left, and both had the same
 * problem: the column is 224 pixels, and a repository path is not. Every name
 * deeper than `src/features/` wrapped onto two or three lines, which turned a
 * list you scan into a list you read - and the one thing a file list has to do
 * is let you find a file without reading it.
 *
 * A breakpoint cannot fix that, because the right width is not a property of
 * the window. It depends on how deep the project nests, how long its names are,
 * and whether the person is reading the list or the code beside it. So the
 * column is draggable, and where it is dragged to is remembered.
 *
 * ## What is remembered, and what is not
 *
 * Only a width that was actually chosen. Until someone drags the grip the
 * column keeps the responsive width it always had - `w-56`, wider at `xl` and
 * `2xl` - and grows with the window. A stored number replaces all three, on
 * purpose: a person who has said "this wide" has answered the question the
 * breakpoints were guessing at, and a column that jumped at 1280 pixels *after*
 * being set would be ignoring them.
 *
 * The two tabs store it under different keys. They are different lists next to
 * different things - a few dozen changed files beside a diff, every file in the
 * repository beside one file - and the width that suits one need not suit the
 * other.
 *
 * ## The grip
 *
 * A `separator` with `aria-valuenow`, which is what a pointer *and* a keyboard
 * can both work: arrows nudge it, `Home` and `End` take it to its limits, and a
 * double-click gives the stylesheet its column back. Resizing a panel with the
 * keyboard is not a common thing to want, but a control that can only be
 * dragged is one that some people simply do not have.
 *
 * Nothing about this exists on a narrow window, where the list is the whole
 * screen instead of a column beside something - there is no second thing for it
 * to take room from.
 */
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { useStoredNumber } from '@/lib/preferences'
import { cn } from '@/lib/utils'

/**
 * Narrow enough to be a gutter, wide enough to be half the screen.
 *
 * The floor is about where a file name stops fitting at all; below it the
 * column is worse than closed, and closing it is a button away. The ceiling is
 * a guard against dragging the code out of the window entirely and then having
 * to find the grip again - it is also clamped against the window below.
 */
const MIN_WIDTH = 160
const MAX_WIDTH = 720

/** How far an arrow key moves the edge. A comfortable few characters. */
const KEY_STEP = 16

/** The widest the column may be, given a window this size. */
function ceiling(): number {
  if (typeof window === 'undefined') return MAX_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)))
}

function clamp(width: number): number {
  return Math.max(MIN_WIDTH, Math.min(ceiling(), Math.round(width)))
}

export interface SidebarColumnProps {
  /** Where the chosen width is remembered. One per list, not one per app. */
  storageKey: string
  /** True when the list is the screen rather than a column beside something. */
  narrow: boolean
  /** What the column is called, for the grip's label. */
  label: string
  className?: string
  children: ReactNode
}

export function SidebarColumn({
  storageKey,
  narrow,
  label,
  className,
  children
}: SidebarColumnProps) {
  const [stored, store] = useStoredNumber(storageKey, null)
  /** The whole column, whose left edge a drag measures from. */
  const column = useRef<HTMLDivElement | null>(null)
  /**
   * The width during a drag, before it is committed.
   *
   * Held apart from the stored value so that a drag writes to `localStorage`
   * once, when the pointer is released, rather than on every frame of the
   * movement.
   */
  const [dragging, setDragging] = useState<number | null>(null)
  const width = dragging ?? stored

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only the primary button, and never a drag that started as a text
      // selection in the list.
      if (event.button !== 0) return
      const element = column.current
      if (element === null) return

      event.preventDefault()
      const left = element.getBoundingClientRect().left
      const handle = event.currentTarget
      handle.setPointerCapture(event.pointerId)

      // Measured from the column's own left edge rather than from where the
      // pointer went down, so the edge lands under the cursor instead of
      // drifting by however far into the grip the press happened to be.
      const move = (at: number): void => setDragging(clamp(at - left))
      move(event.clientX)

      const onMove = (moved: PointerEvent): void => move(moved.clientX)
      const onUp = (ended: PointerEvent): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        setDragging(null)
        store(clamp(ended.clientX - left))
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
    },
    [store]
  )

  const nudge = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const current = column.current?.getBoundingClientRect().width ?? MIN_WIDTH
      switch (event.key) {
        case 'ArrowLeft':
          store(clamp(current - KEY_STEP))
          break
        case 'ArrowRight':
          store(clamp(current + KEY_STEP))
          break
        case 'Home':
          store(MIN_WIDTH)
          break
        case 'End':
          store(ceiling())
          break
        // Back to the stylesheet's width, which is also how a reader undoes a
        // drag they did not mean to make.
        case 'Enter':
        case 'Backspace':
        case 'Delete':
          store(null)
          break
        default:
          return
      }
      event.preventDefault()
    },
    [store]
  )

  if (narrow) {
    return (
      <aside className={cn('w-full rounded-lg border border-border bg-card/50', className)}>
        {children}
      </aside>
    )
  }

  return (
    // The sticky box is the wrapper rather than the list, so the grip beside it
    // is a flex sibling and stretches to exactly the list's height - which a
    // grip given a height of its own cannot do without either falling short on
    // a long list or pushing the page taller than its content on a short one.
    //
    // The offset is the files tab's, which shifts down by the find bar when
    // that is open; the browse tab sets no such variable and lands on the
    // fallback.
    <div
      ref={column}
      style={width === null ? undefined : { width }}
      className={cn(
        'sticky top-[var(--diff-scroll-top,0.5rem)] flex max-h-[calc(100dvh-6rem)] shrink-0',
        // Only while nobody has chosen: a set width has answered this.
        width === null && 'w-56 xl:w-64 2xl:w-72'
      )}
    >
      <aside
        className={cn(
          'min-w-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card/50',
          className
        )}
      >
        {children}
      </aside>

      {/* Pulled back out of the column by exactly its own width, so the grip
          floats in the gap the layout already leaves between the list and the
          code: the list is as wide as it was asked to be, and nothing else
          moves when the grip appears. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        // Left off until there is one: before anyone has dragged, the width is
        // whatever the stylesheet made it, and a number read off the DOM during
        // render would be last frame's answer rather than this one's.
        aria-valuenow={width ?? undefined}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={nudge}
        onDoubleClick={() => store(null)}
        title="Drag to resize. Double-click to reset."
        className={cn(
          'group -mr-2 flex w-2 shrink-0 items-stretch',
          'cursor-col-resize touch-none select-none focus-visible:outline-none'
        )}
      >
        {/* A hairline that appears under the pointer: the target is eight
            pixels wide so it can be hit, and one pixel wide so it is not a bar
            down the middle of the screen. */}
        <div
          className={cn(
            'mx-auto w-px rounded-full transition-colors',
            'bg-transparent group-hover:bg-border',
            'group-focus-visible:w-0.5 group-focus-visible:bg-ring',
            dragging !== null && 'w-0.5 bg-ring'
          )}
        />
      </div>
    </div>
  )
}
