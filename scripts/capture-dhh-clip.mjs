/**
 * A short clip answering one complaint, recorded from the browser shell.
 *
 * DHH, on the Lex Fridman podcast (#501, at 1:40:37), on reviewing what an
 * agent just wrote:
 *
 *   "When I look at Hunk, I only see the change set, and when I'm reviewing
 *    output from an agent, I often want to see the surrounding context. Oh,
 *    yeah, so it changed this file, but actually, what do we have in this
 *    other file that wasn't touched but maybe should've been touched?"
 *
 * That is two questions, and the clip answers them in order: **Expand all
 * lines** turns a change set back into a file, and the browse tab reaches a
 * file the change never touched. Nothing is narrated and nothing is claimed
 * on screen that the app does not do.
 *
 * ## Why a browser and not the app
 *
 * A minute earlier in the same conversation: "if GitHub was a little faster at
 * showing you your pull request, the web is probably actually a nicer place to
 * do that." So this one is shot against `gitwarren serve` in Chrome rather
 * than against the Electron window. It is the same renderer either way - the
 * shell is the only thing that differs - and a screencast is of the *page*, so
 * no tab strip or address bar is ever in frame.
 *
 * ## Setup
 *
 * The demo repositories and a seeded database, exactly as the hero video takes
 * them:
 *
 *   DEMO_REPO_ROOT=~/Developer/klarluft scripts/make-demo-repos.sh
 *   rm -rf /tmp/gw-demo
 *   GITWARREN_DATA_DIR=/tmp/gw-demo DEMO_REPO_ROOT=~/Developer/klarluft npx tsx scripts/seed-demo.ts
 *
 * Then the web build, and the server that hands it out. `serve` prints the URL
 * with its per-launch token on the end; it is needed below:
 *
 *   npm run build:web
 *   GITWARREN_DATA_DIR=/tmp/gw-demo npx tsx src/cli/gitwarren.ts serve
 *
 * Then a Chrome with a debugging port and nothing else in it. A scratch
 * profile keeps it to one tab, which is the one this attaches to:
 *
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --remote-debugging-port=9222 --user-data-dir=/tmp/gw-chrome \
 *     --no-first-run --no-default-browser-check \
 *     'http://127.0.0.1:41427/?token=<the token serve printed>'
 *
 * And finally, from another terminal (ffmpeg must be on PATH):
 *
 *   node scripts/capture-dhh-clip.mjs
 *
 * Outputs land in VIDEO_DIR (default: a gitignored `video-out/`) as
 * dhh-clip.mp4, .webm and .png. The mp4 is the one X wants.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, hideScrollbars, settle, wait } from './cdp.mjs'
import { Recorder, encode } from './record.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = process.env.VIDEO_DIR ?? 'video-out'
const FRAME_DIR = join(tmpdir(), 'gitwarren-dhh-frames')

/**
 * 16:9 rather than the hero's 3:2. X plays a landscape video inline at about
 * this shape, and a letterboxed clip in a timeline reads as a screenshot of a
 * video rather than as a video.
 */
const SIZE = { width: 1280, height: 720 }
const SCALE = 2
const FPS = 30

const REVIEW_ID = Number(process.env.DEMO_REVIEW_ID ?? 1)

/**
 * The file the change *did* touch: committed bindings plus a staged edit, in a
 * file long enough that git's three lines of context hide most of it. This is
 * the "I only see the change set" frame.
 */
const CHANGED_FILE = 'src/renderer/src/features/reviews/review-files-tab.tsx'

/**
 * The file it did not.
 *
 * The registry the branch adds declares three scopes - files, conversation and
 * commits - and the diff binds only the first. The conversation tab is where
 * the missing half would go, and nothing in the review points at it, which is
 * exactly the file the quote is asking after.
 */
const UNTOUCHED_FILE = 'src/renderer/src/features/reviews/review-conversation-tab.tsx'

// ---- input ------------------------------------------------------------------

/** A bare key press, as the hotkey layer sees it. Never inserts text. */
async function press(cdp, key, code, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
}

async function moveMouse(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

async function click(cdp, x, y) {
  await moveMouse(cdp, x, y)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await wait(60)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// ---- the page --------------------------------------------------------------

/** Put a file's card at the top of the page, the way clicking the tree does. */
async function scrollToFile(cdp, file) {
  const found = await cdp.evaluate(`(() => {
    const card = document.getElementById('file-' + encodeURIComponent(${JSON.stringify(file)}))
    if (!card) return null
    card.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return 'ok'
  })()`)
  if (found !== 'ok') throw new Error(`No card for ${file} on screen`)
}

/**
 * Where a file card's "Expand all lines" button is, or null when the file has
 * nothing folded - which is worth failing on rather than recording, since a
 * clip of that button doing nothing is the opposite of the point.
 */
async function locateExpandAll(cdp, file) {
  return cdp.evaluate(`(() => {
    const card = document.getElementById('file-' + encodeURIComponent(${JSON.stringify(file)}))
    if (!card) return null
    const button = card.querySelector('button[aria-label="Expand all lines in this file"]')
    if (!button || button.offsetParent === null) return null
    const r = button.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
}

/**
 * How many folded gaps the file still has, so the expansion can be proved.
 *
 * The gutter's expanders say "Show 20 more lines" / "Show all 144 hidden
 * lines"; the toolbar's says "Expand all lines in this file" and stays put
 * whether anything is folded or not. Only the first kind answers this.
 */
function countExpanders(cdp, file) {
  return cdp.evaluate(`(() => {
    const card = document.getElementById('file-' + encodeURIComponent(${JSON.stringify(file)}))
    if (!card) return -1
    return card.querySelectorAll('button[aria-label^="Show "]').length
  })()`)
}

async function goTo(cdp, hash) {
  await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`)
  await wait(300)
  await settle(cdp)
}

// ---- the storyboard ----------------------------------------------------------

async function main() {
  const cdp = await Cdp.attach(PORT)

  // Hover and focus must work even while the OS has some other window in front.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: SIZE.width,
    height: SIZE.height,
    deviceScaleFactor: SCALE,
    mobile: false
  })
  await hideScrollbars(cdp)

  // Unfolded gaps and the open file survive a hash change, so a second take in
  // the same tab would start where the first one finished. Reload instead: this
  // clip writes nothing, so the page is the only state a take has.
  await cdp.send('Page.reload', { ignoreCache: false })
  await wait(2500)
  await settle(cdp)

  // Warm both tabs before recording, so the clip shows the product rather than
  // a skeleton while git is asked a question.
  await goTo(cdp, `#/reviews/${REVIEW_ID}/browse/${encodeURIComponent(UNTOUCHED_FILE)}`)
  await wait(800)
  await goTo(cdp, `#/reviews/${REVIEW_ID}/files`)
  await wait(800)

  const folded = await countExpanders(cdp, CHANGED_FILE)
  if (folded < 1) throw new Error(`${CHANGED_FILE} has nothing folded; the clip has no point to make`)

  // Park the pointer where it hovers nothing, and start from the top.
  await moveMouse(cdp, SIZE.width - 12, SIZE.height - 12)
  await cdp.evaluate(`document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' })`)
  await wait(600)

  const recorder = new Recorder(cdp, { frameDir: FRAME_DIR, size: SIZE, scale: SCALE, fps: FPS })
  await recorder.start()

  // 1. What is under review: an agent's work, still uncommitted.
  await wait(2400)

  // 2. The change set, and only the change set - three lines of context, and
  //    the rest of the file folded away behind the expanders.
  await scrollToFile(cdp, CHANGED_FILE)
  await wait(3000)

  // 3. The first half of the answer: the file, whole, with the change in it.
  const button = await locateExpandAll(cdp, CHANGED_FILE)
  if (!button) throw new Error('No "Expand all lines" button on the changed file')
  await moveMouse(cdp, button.x, button.y)
  await wait(450)
  await click(cdp, button.x, button.y)
  await wait(1400)
  const left = await countExpanders(cdp, CHANGED_FILE)
  if (left !== 0) throw new Error(`Expand all left ${left} gaps folded`)
  await moveMouse(cdp, SIZE.width - 12, SIZE.height - 12)
  await wait(2400)

  // 4. Reading down through context that was never in the diff.
  await cdp.evaluate(`document.querySelector('main')?.scrollBy({ top: 620, behavior: 'smooth' })`)
  await wait(2400)

  // 5. The second half: the tab that reaches a file the change never touched.
  await press(cdp, '4', 'Digit4', 52)
  await wait(1800)

  // 6. And there it is - the conversation tab, which the branch's own registry
  //    declares a scope for and never binds.
  //
  //    The scroll offset is the diff's, carried across the tab switch, so the
  //    file would otherwise open halfway down. It should start where a file
  //    starts.
  await goTo(cdp, `#/reviews/${REVIEW_ID}/browse/${encodeURIComponent(UNTOUCHED_FILE)}`)
  await cdp.evaluate(`document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' })`)
  await wait(3600)

  await recorder.stop()
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()

  await encode(recorder, { outDir: OUT_DIR, name: 'dhh-clip', loopFade: null })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
