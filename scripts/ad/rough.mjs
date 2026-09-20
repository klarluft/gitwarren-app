/**
 * A rough of the horizontal cut: the product clips on the storyboard's clock,
 * with a labelled slate wherever a Runway beat, the terminal or the phone
 * will go. Silent. Not a deliverable - a timing reference for the edit, so
 * the voice-over can be read against it and each product beat's true length
 * seen next to the seconds the storyboard gave it.
 *
 * Product clips are laid at their natural length after a trim; when one runs
 * past its slot, the clock after it shifts, and the printed timeline says by
 * how much. That is the number the edit has to find (faster typing, a cut
 * inside a clip, or a later VO line), and the rough exists to make it visible
 * rather than to hide it.
 *
 *   node scripts/ad/rough.mjs
 *
 * Reads `<beat>.mp4` and `end-card-16x9.png` from VIDEO_DIR (default
 * `video-out/ad/`) and writes `rough.mp4` beside them.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHtml } from './end-card.mjs'

const DIR = process.env.VIDEO_DIR ?? 'video-out/ad'
const W = 1920
const H = 1080
const FPS = 30

/**
 * The timeline. A slate is `{ slate, seconds }`; a clip is `{ clip, from, seconds }`
 * (seconds after trimming the head by `from`; null means the whole rest).
 */
const TIMELINE = [
  { slate: 'RUNWAY A  ·  dark room  ·  the chime', seconds: 3 },
  { slate: 'RUNWAY B  ·  café', seconds: 3 },
  { slate: 'RUNWAY C  ·  laundry', seconds: 3 },
  { slate: 'RUNWAY D  ·  dog park', seconds: 3 },
  { slate: 'RUNWAY E  ·  airport gate', seconds: 3 },
  { slate: 'TERMINAL  ·  Claude Code prints the review link  ·  zoom in from A', seconds: 3 },
  { clip: 'review-opens', from: 0.3, seconds: 4 },
  { clip: 'scroll-diff', from: 0.3, seconds: 4 },
  { clip: 'comment-and-reply', from: 0.2, seconds: null },
  { clip: 'browse-untouched', from: 0.2, seconds: null },
  { clip: 'hosts', from: 0.3, seconds: 5 },
  { slate: 'PHONE  ·  filmed  ·  the same review over the tailnet', seconds: 4 },
  { slate: 'TERMINAL  ·  "left some comments in gitwarren, please check"', seconds: 3 },
  { slate: 'RUNWAY D, C, B  ·  tails  ·  phones going away', seconds: 3 },
  { slate: 'RUNWAY A  ·  bookend', seconds: 3 },
  { image: 'end-card-16x9.png', seconds: 5 }
]

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(String(out).trim())
}

/**
 * A slate: a labelled card for a shot that is not footage yet. Rendered to a
 * PNG through Chrome, because Homebrew's ffmpeg is built without `drawtext`.
 */
function slate(text, dir, index) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    * { margin:0; box-sizing:border-box }
    body { width:${W}px; height:${H}px; background:#1a1a1f; color:#cfcbc4; display:flex; align-items:center; justify-content:center;
      font: 500 44px/1.4 "IBM Plex Sans", -apple-system, "Helvetica Neue", sans-serif; text-align:center; padding:0 160px }
    small { position:absolute; left:40px; bottom:32px; font-size:24px; color:#8f8a82; letter-spacing:.08em }
  </style><body>${text}<small>SLATE — NOT FOOTAGE</small></body>`
  return renderHtml(html, { width: W, height: H, scale: 1 }, join(dir, `slate-${index}.png`))
}

const slates = mkdtempSync(join(tmpdir(), 'gw-rough-'))
const inputs = []
const filters = []
const labels = []
let clock = 0
const rows = []

TIMELINE.forEach((item, index) => {
  const label = `v${index}`
  let seconds
  if (item.slate || item.image) {
    seconds = item.seconds
    const file = item.image ? join(DIR, item.image) : slate(item.slate, slates, index)
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(seconds), '-i', file)
    filters.push(`[${inputs.filter((a) => a === '-i').length - 1}:v]scale=${W}:${H},format=yuv420p,setsar=1[${label}]`)
  } else {
    const file = join(DIR, `${item.clip}.mp4`)
    if (!existsSync(file)) throw new Error(`Missing ${file}; record it first`)
    const available = probe(file) - item.from
    seconds = item.seconds === null ? available : Math.min(item.seconds, available)
    inputs.push('-ss', String(item.from), '-t', String(seconds), '-i', file)
    filters.push(`[${inputs.filter((a) => a === '-i').length - 1}:v]fps=${FPS},scale=${W}:${H},format=yuv420p,setsar=1[${label}]`)
  }
  labels.push(`[${label}]`)
  rows.push({ at: clock, seconds, what: item.slate ?? item.clip ?? item.image })
  clock += seconds
})

filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[out]`)

const out = join(DIR, 'rough.mp4')
execFileSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out],
  { stdio: 'inherit' }
)

const mmss = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
console.log(`\n${out}\n`)
for (const row of rows) console.log(`${mmss(row.at).padStart(6)}  ${row.seconds.toFixed(1).padStart(5)}s  ${row.what}`)
console.log(`${mmss(clock).padStart(6)}  end (storyboard: 0:58.0)`)
