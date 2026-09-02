/**
 * Scroll to an element that may not exist yet.
 *
 * Jumping to a file from the command palette usually means changing tab first,
 * so the target is still being rendered when the jump is asked for. Retrying
 * across a handful of frames covers that without anyone having to coordinate:
 * whoever wants the scroll asks for it, and it happens as soon as the thing to
 * scroll to appears.
 *
 * A target that never turns up is silence rather than an error - the file left
 * the diff, and there is nothing useful to say about it mid-jump.
 */

/** Half a second at 60Hz: long enough for a tab switch, short enough to drop. */
const MAX_FRAMES = 30

export function revealElement(
  id: string,
  options: ScrollIntoViewOptions = { block: 'start', behavior: 'smooth' }
): () => void {
  let frames = 0
  let frame = 0

  const attempt = (): void => {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView(options)
      return
    }
    frames += 1
    if (frames < MAX_FRAMES) frame = requestAnimationFrame(attempt)
  }

  frame = requestAnimationFrame(attempt)
  return () => cancelAnimationFrame(frame)
}
