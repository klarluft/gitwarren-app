/**
 * Frames out of a running renderer, and files out of the frames.
 *
 * Extracted from `capture-hero-video.mjs` when a second video wanted the same
 * machinery with a different story to tell. The split is the same one
 * `cdp.mjs` already makes: how to talk to the page is shared, what to say to
 * it is not. A storyboard script owns its sequence and its output names; this
 * owns the screencast, the timing and ffmpeg.
 *
 * Nothing here knows which shell is on the other end of the protocol. Electron
 * and Chrome answer `Page.startScreencast` identically, and a screencast is of
 * the *page*, so a browser's own tabs and address bar are never in frame.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class Recorder {
  frames = []
  marks = {}
  squeezes = []
  #writes = []
  #off = null

  /**
   * @param cdp a connected `Cdp`
   * @param options `frameDir` to spool PNGs into, the `size` and `scale` the
   *   page is being emulated at, and the `fps` the cut will run at. The
   *   screencast itself is irregular by design; the rate is what the cut is
   *   resampled to, and says nothing about how long any one frame lasted.
   */
  constructor(cdp, { frameDir, size, scale, fps }) {
    this.cdp = cdp
    this.frameDir = frameDir
    this.size = size
    this.scale = scale
    this.fps = fps
  }

  /** Remember the moment something happened, on the screencast's clock. */
  mark(name) {
    this.marks[name] = Date.now() / 1000
  }

  /**
   * Make the stretch between two marks last exactly `seconds` in the cut.
   *
   * For waits whose real length is not part of the story - the agent's reply
   * arrives whenever the comment list next refreshes, which is anything from
   * a moment to a few seconds - the recording keeps what happened and the
   * edit decides how long it takes.
   */
  squeeze(from, to, seconds) {
    this.squeezes.push({ from, to, seconds })
  }

  async start() {
    await rm(this.frameDir, { recursive: true, force: true })
    await mkdir(this.frameDir, { recursive: true })

    this.#off = this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = join(this.frameDir, `${String(this.frames.length).padStart(5, '0')}.png`)
      this.frames.push({ file, at: metadata.timestamp })
      this.#writes.push(writeFile(file, Buffer.from(data, 'base64')))
      void this.cdp.send('Page.screencastFrameAck', { sessionId })
    })

    // A frame arrives whenever the compositor has something new, stamped with
    // when that was; nothing arrives while the screen is still. The timestamps
    // are what make the recording faithful, not any frame rate of ours.
    await this.cdp.send('Page.startScreencast', {
      format: 'png',
      maxWidth: this.size.width * this.scale,
      maxHeight: this.size.height * this.scale,
      everyNthFrame: 1
    })
  }

  async stop() {
    await this.cdp.send('Page.stopScreencast')
    this.#off?.()
    this.endedAt = Date.now() / 1000
    await Promise.all(this.#writes)
  }
}

export function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })
}

export function probe(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('exit', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error('ffprobe failed'))))
  })
}

/**
 * Frames to files.
 *
 * The concat demuxer takes each frame with the time until the next one, which
 * turns the irregular screencast into a constant-rate stream. A near-lossless
 * master is cut first; the deliverables are encoded from it, so the expensive
 * part is done once.
 *
 * `loopFade` is what separates a hero loop from a clip that simply ends. Given
 * a number, the opening frame is held past the end and crossfaded back to, so
 * the last frame *is* the first and the video loops without a seam. Given
 * null, the cut ends where the storyboard stopped.
 *
 * `width` is the delivered width; the frames are whatever the page was
 * emulated at. A page shot small and scaled up is a page whose text is larger
 * in the frame, which is what a clip watched on a phone needs, and the scale is
 * done once here on the master rather than on each deliverable.
 *
 * @returns the paths written.
 */
export async function encode(recorder, { outDir, name, loopFade = null, poster = true, width = null }) {
  const { frames, endedAt, marks, squeezes, frameDir, fps } = recorder
  if (frames.length < 2) throw new Error('Too few frames recorded')

  // Each frame lasts until the next one arrived, and no longer. This used to
  // floor every frame at 1/fps, which read as harmless until a clip was cut on
  // a 120Hz display: a scroll or a fade delivers a frame per compositor tick,
  // every one of them was stretched to 33ms, and a 27-second recording came
  // out at 46. The `fps` filter below picks whichever frame is showing at each
  // tick of the cut, which is the right thing to do with frames 8ms apart.
  const durations = frames.map((frame, index) => {
    const next = frames[index + 1]
    return Math.max((next ? next.at : endedAt) - frame.at, 0.001)
  })

  // A frame is on screen from its timestamp until the next one, so the frame
  // that is showing when a window closes straddles the boundary - the reply
  // frame's time on screen is mostly the hold after it. Only the part of each
  // frame inside the window is rescaled; the rest keeps its real length.
  for (const { from, to, seconds } of squeezes) {
    const start = marks[from]
    const end = marks[to]
    const overlap = frames.map((frame, index) => {
      const shownUntil = frame.at + durations[index]
      return Math.max(0, Math.min(shownUntil, end) - Math.max(frame.at, start))
    })
    const total = overlap.reduce((sum, part) => sum + part, 0)
    if (total === 0) continue
    const factor = seconds / total
    frames.forEach((_, index) => {
      durations[index] = durations[index] - overlap[index] + overlap[index] * factor
    })
  }

  const list = frames
    .map((frame, index) => `file '${frame.file}'\nduration ${durations[index].toFixed(4)}`)
    .join('\n')
  const listFile = join(frameDir, 'frames.txt')
  // The demuxer ignores the last duration unless the last file is repeated.
  await writeFile(listFile, `${list}\nfile '${frames.at(-1).file}'\n`)

  await mkdir(outDir, { recursive: true })
  const master = join(frameDir, 'master.mp4')
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=${fps}${width === null ? '' : `,scale=${width}:-2:flags=lanczos`},format=yuv444p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8',
    master
  ])

  const duration = await probe(master)

  // One shape for both deliverables: either a crossfade back to the opening
  // frame, or the master straight through.
  let inputs = ['-i', master]
  let filter = null
  if (loopFade !== null) {
    const fadeAt = (duration - loopFade).toFixed(3)
    filter =
      // Both inputs on one clock, or xfade refuses to join them.
      // The tail is a raw frame, so it takes the same scale the master did.
      `[1:v]${width === null ? '' : `scale=${width}:-2:flags=lanczos,`}format=yuv420p,fps=${fps},settb=AVTB[tail];` +
      `[0:v]format=yuv420p,fps=${fps},settb=AVTB[main];` +
      `[main][tail]xfade=transition=fade:duration=${loopFade}:offset=${fadeAt}`
    inputs = [
      '-i', master,
      // The opening frame, held just past the fade so the last frame *is* the first.
      '-loop', '1', '-framerate', String(fps), '-t', String(loopFade + 0.2), '-i', frames[0].file
    ]
  }
  const shape = filter === null ? ['-vf', 'format=yuv420p'] : ['-filter_complex', filter]

  const mp4 = join(outDir, `${name}.mp4`)
  await run('ffmpeg', [
    '-y', '-loglevel', 'error', ...inputs, ...shape,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high', '-level', '5.1',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    mp4
  ])

  const webm = join(outDir, `${name}.webm`)
  await run('ffmpeg', [
    '-y', '-loglevel', 'error', ...inputs, ...shape,
    '-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1',
    '-pix_fmt', 'yuv420p', '-an',
    webm
  ])

  const written = [mp4, webm]
  if (poster) {
    const file = join(outDir, `${name}.png`)
    await copyFile(frames[0].file, file)
    written.push(file)
  }

  console.log(`${frames.length} frames, ${duration.toFixed(1)}s`)
  for (const file of written) console.log(`  ${file}`)
  return written
}
