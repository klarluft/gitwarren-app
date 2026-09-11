/**
 * Newline-delimited JSON, as a reader.
 *
 * Extracted from `stdio.ts` at M4, when the protocol grew a second side. Until
 * then only the daemon read frames; now the GUI reads them too - it is the one
 * asking the questions over `ssh` - and two implementations of "where does a
 * frame end" is exactly the kind of disagreement that produces a hang rather
 * than an error. A hang on a pipe is the worst bug shape available: both ends
 * are healthy, both are waiting, and nothing is logged.
 *
 * So the framing lives here, once, and `stdio.ts` (the server) and
 * `stdio-client.ts` (the client) are both users of it. Neither may parse a
 * stream itself.
 *
 * The rationale for newline-delimited rather than a length prefix is at the top
 * of `stdio.ts`, where it belongs with the protocol it serves.
 */

/**
 * How much of an unterminated line to hold before giving up.
 *
 * A frame is a request, and requests are tiny - with one exception. An image on
 * its way into the attachment store travels as bytes, and 10 MB of them (the
 * ingest limit) is about 14 MB once base64 has had them, or four times that if
 * a caller sends the `number[]` form. 64 MB leaves room for the worst of those
 * and still bounds what a peer that never sends a newline can make this process
 * allocate.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export interface FrameReaderOptions {
  /** One complete frame, already trimmed and never empty. */
  onFrame: (line: string) => void
  /**
   * A peer that sent `MAX_FRAME_BYTES` without a newline. The buffer has been
   * dropped by the time this is called, so the reader is usable afterwards -
   * whether it *should* be used again is the caller's decision, and the two
   * sides answer it differently: a server refuses the frame and reads on, a
   * client treats it as a broken connection.
   */
  onOverflow: (bytes: number) => void
  /** The stream ended. Any trailing frame has already been delivered. */
  onEnd?: () => void
}

/**
 * Read `input` as frames.
 *
 * A chunk boundary falls wherever the OS put it and means nothing: everything
 * up to the last newline is complete frames, and whatever follows it is the
 * start of the next one and stays in the buffer.
 *
 * Blank lines are skipped rather than reported. A peer that pads its output, or
 * a log being replayed by hand, should not produce an error - and on the client
 * side this matters for a reason peculiar to `ssh`, which is happy to put a
 * bare newline on the stream around a banner.
 */
export function readFrames(
  input: NodeJS.ReadableStream,
  { onFrame, onOverflow, onEnd }: FrameReaderOptions
): void {
  let buffer = ''

  input.setEncoding('utf8')

  input.on('data', (chunk: string) => {
    buffer += chunk

    if (buffer.length > MAX_FRAME_BYTES && !buffer.includes('\n')) {
      const bytes = buffer.length
      buffer = ''
      onOverflow(bytes)
      return
    }

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onFrame(line)
      newline = buffer.indexOf('\n')
    }
  })

  input.on('end', () => {
    // A trailing frame with no newline after it. Honoured, because a peer that
    // writes a message and closes the pipe has said a perfectly good thing.
    const line = buffer.trim()
    buffer = ''
    if (line) onFrame(line)
    onEnd?.()
  })
}
