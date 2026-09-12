/**
 * Choosing the lines a new comment is about.
 *
 * Two gestures, both of which people already know from GitHub: press and drag
 * the `+` down the gutter, or shift-click a second line. They are the same
 * gestures over a diff and over a whole file, which is why this is a hook
 * rather than state inside the diff card - `FileDiffCard` and `FileSourceCard`
 * are two different ways of drawing lines, and exactly one way of selecting
 * them.
 *
 * The touch handling below is the reason it is worth sharing rather than
 * writing twice. It is not obvious, it was arrived at by testing on a phone,
 * and a second copy would be a second copy that does not have it.
 */
import { useCallback, useEffect, useState } from 'react'
import type { DiffSide } from '@shared/comment-anchors'

/**
 * A run of lines on one side: what a comment covers, and what the reviewer is
 * dragging out before the composer opens. `startLine === line` is an ordinary
 * single-line comment, which is most of them.
 */
export interface LineRange {
  side: DiffSide
  startLine: number
  line: number
}

export interface LineSelection {
  /** The lines the reviewer is writing a new comment on, if any. */
  composingOn: LineRange | null
  /** Open the composer on a range, or close it with null. */
  setComposingOn: (target: LineRange | null) => void
  /** Begin a selection at this line, or extend the open one when held. */
  startSelection: (side: DiffSide, line: number, extend: boolean) => void
  /** Drag the selection over this line. Ignored when nothing is being dragged. */
  dragOver: (side: DiffSide, line: number) => void
  /**
   * The range to light up right now - the drag while the pointer is down, the
   * composer's own range after it comes up. Normalised, so `startLine` is
   * always the earlier of the two however the drag ran.
   */
  selection: LineRange | null
  /**
   * True while the pointer is down. The code is made unselectable for exactly
   * that long: dragging the gutter otherwise leaves the whole file highlighted
   * as a text selection behind the range being chosen.
   */
  isDragging: boolean
}

export function useLineSelection(): LineSelection {
  const [composingOn, setComposingOn] = useState<LineRange | null>(null)
  /** The range being dragged out right now, before the pointer comes up. */
  const [dragging, setDragging] = useState<LineRange | null>(null)

  /**
   * Start commenting at a line, or grow the open range to reach it.
   *
   * Shift-click keeps the first line of the existing range as the anchor, so
   * the range only ever grows away from where the reviewer started.
   */
  const startSelection = useCallback(
    (side: DiffSide, line: number, extend: boolean) => {
      if (extend && composingOn && composingOn.side === side) {
        const anchor = composingOn.startLine
        setComposingOn({ side, startLine: Math.min(anchor, line), line: Math.max(anchor, line) })
        return
      }
      setDragging({ side, startLine: line, line })
    },
    [composingOn]
  )

  const dragOver = useCallback((side: DiffSide, line: number) => {
    setDragging((current) => {
      if (!current || current.side !== side || current.line === line) return current
      // `startLine` stays the line the drag began on; the pointer can be either
      // side of it, and the range is normalised when the pointer comes up.
      return { ...current, line }
    })
  }, [])

  /**
   * A drag ends wherever the pointer is released, which is often outside the
   * button - or outside the card - so the listener goes on the window.
   *
   * The *move* is on the window for a different and less obvious reason. Rows
   * also report `onPointerEnter`, and with a mouse that is enough: the pointer
   * really does travel across each row and each row really is told. A finger
   * does not work that way. Touch sets *implicit pointer capture* on whatever
   * the gesture started on - the `+` button - so for the rest of the drag every
   * pointer event is delivered to that button and no row is ever entered. The
   * range simply never grew, which is why dragging out several lines worked on
   * a desktop and did nothing at all on a phone.
   *
   * So the pointer is followed rather than waited for: one listener, hit-test
   * where it actually is, read the row's own `data-diff-*` off the result. That
   * is correct for a mouse too - `onPointerEnter` stays because it costs
   * nothing and keeps the desktop path working if a hit-test ever lands on
   * something unexpected - and it is the same set of coordinates either way.
   */
  useEffect(() => {
    if (!dragging) return

    const move = (event: PointerEvent): void => {
      const under = document.elementFromPoint(event.clientX, event.clientY)
      const row = under?.closest('[data-diff-line]')
      if (!row) return
      const side = row.getAttribute('data-diff-side')
      const line = Number(row.getAttribute('data-diff-line'))
      if ((side === 'base' || side === 'head') && Number.isInteger(line)) dragOver(side, line)
    }

    const finish = (): void => {
      const startLine = Math.min(dragging.startLine, dragging.line)
      const line = Math.max(dragging.startLine, dragging.line)
      setDragging(null)
      setComposingOn((current) =>
        // Clicking the `+` of a composer that is already open on exactly those
        // lines closes it again, which is how the button worked before ranges.
        current && current.side === dragging.side && current.startLine === startLine && current.line === line
          ? null
          : { side: dragging.side, startLine, line }
      )
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [dragging, dragOver])

  return {
    composingOn,
    setComposingOn,
    startSelection,
    dragOver,
    // While the pointer is down the drag wins; after it comes up the composer's
    // own range is what stays lit.
    selection: dragging
      ? {
          side: dragging.side,
          startLine: Math.min(dragging.startLine, dragging.line),
          line: Math.max(dragging.startLine, dragging.line)
        }
      : composingOn,
    isDragging: dragging !== null
  }
}
