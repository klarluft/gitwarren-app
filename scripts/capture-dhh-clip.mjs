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
 * file the change never touched. Then a third beat for the other half of his
 * setup - a stack of machines on a tailnet - showing one of them reviewed from
 * here. Nothing is claimed on screen that the app does not do: the host on the
 * Hosts screen is a real machine, reached for real while the clip records.
 *
 * ## What the second cut fixed
 *
 * The first cut was twenty-five seconds of dark code with no cursor and no
 * words, and the honest review of it was "I don't know what I'm looking at".
 * So every beat now has a one-line caption saying what it is, the pointer is
 * drawn (a screencast has none), and the page is shot smaller and delivered
 * larger so the product is legible at a phone's width. See `overlay.mjs`.
 *
 * The holds are on a clock rather than a chain of waits. A caption swap, a
 * pointer glide and a `settle` each cost a fraction of a second, and nine beats
 * of those added eighteen seconds to a cut budgeted at twenty-four. So each
 * beat now ends at a fixed second from the first frame, and whatever the
 * overhead turns out to be comes out of the hold rather than the total.
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
 * The demo repositories and a seeded database, as the hero video takes them,
 * plus one host on the tailnet for the third beat (any machine of yours that
 * is running GitWarren with "Reachable on your tailnet" on):
 *
 *   DEMO_REPO_ROOT=~/Developer/klarluft scripts/make-demo-repos.sh
 *   rm -rf /tmp/gw-demo
 *   GITWARREN_DATA_DIR=/tmp/gw-demo DEMO_REPO_ROOT=~/Developer/klarluft \
 *     DEMO_TAILNET_HOST=pc-win.tail688c0c.ts.net npx tsx scripts/seed-demo.ts
 *
 * Then the web build, and the server that hands it out. `serve` prints the URL
 * with its per-launch token on the end; it is needed below. Run from source
 * the daemon calls itself `0.0.0-dev`, and the host's card would then offer an
 * update to that; give it the version the host actually runs instead:
 *
 *   npm run build:web
 *   NODE_OPTIONS="--import data:text/javascript,globalThis.__APP_VERSION__='0.1.8'" \
 *     GITWARREN_DATA_DIR=/tmp/gw-demo npx tsx src/cli/gitwarren.ts serve
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
import { caption, clickAt, cursorTo, install, parkCursor } from './overlay.mjs'
import { Recorder, encode } from './record.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = process.env.VIDEO_DIR ?? 'video-out'
const FRAME_DIR = join(tmpdir(), 'gitwarren-dhh-frames')

/**
 * 16:9, shot at 1120 wide and delivered at 1920.
 *
 * X plays a landscape video inline at about this shape, and a letterboxed clip
 * in a timeline reads as a screenshot of a video rather than as a video. The
 * viewport is the narrowest the review layout keeps its file tree at, so the
 * product fills the frame and 13px UI text arrives at a phone as large as it
 * is going to get.
 */
const SIZE = { width: 1120, height: 630 }
const SCALE = 2
const FPS = 30
const OUTPUT_WIDTH = 1920

const REVIEW_ID = Number(process.env.DEMO_REVIEW_ID ?? 1)

/** The label the seeded tailnet host gets: the first label of its hostname. */
const HOST_LABEL = process.env.DEMO_TAILNET_LABEL ?? 'pc-win'

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

/** What gets typed into the tree's filter to find it. */
const UNTOUCHED_FILTER = 'conversation-tab'

// ---- the page --------------------------------------------------------------

/**
 * The centre of the first element an expression finds, or null.
 *
 * Null also for an element that exists but is scrolled out of the viewport: a
 * mouse event dispatched at a point off the screen lands on nothing and says
 * nothing, and the second take lost its tab switch to exactly that.
 */
async function locate(cdp, expression) {
  return cdp.evaluate(`(() => {
    const el = (() => { ${expression} })()
    if (!el || el.offsetParent === null) return null
    const r = el.getBoundingClientRect()
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null
    return { x, y }
  })()`)
}

async function locateOrFail(cdp, expression, what) {
  const point = await locate(cdp, expression)
  if (!point) throw new Error(`Cannot find ${what} on screen`)
  return point
}

function fileCard(file) {
  return `document.getElementById('file-' + encodeURIComponent(${JSON.stringify(file)}))`
}

/** Put a file's card at the top of the page, the way clicking the tree does. */
async function scrollToFile(cdp, file) {
  const found = await cdp.evaluate(`(() => {
    const card = ${fileCard(file)}
    if (!card) return null
    card.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return 'ok'
  })()`)
  if (found !== 'ok') throw new Error(`No card for ${file} on screen`)
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
    const card = ${fileCard(file)}
    if (!card) return -1
    return card.querySelectorAll('button[aria-label^="Show "]').length
  })()`)
}

async function goTo(cdp, hash) {
  await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`)
  await wait(300)
  await settle(cdp)
}

function scrollMain(cdp, options) {
  return cdp.evaluate(`document.querySelector('main')?.scrollTo(${JSON.stringify(options)})`)
}

/** Type into whatever has focus, one character at a time, as a person would. */
async function type(cdp, text) {
  for (const char of text) {
    await cdp.send('Input.insertText', { text: char })
    await wait(45)
  }
}

/** A click with the real pointer only: for the warm-up, where nothing records. */
async function plainClick(cdp, { x, y }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

const TRY_NOW = `document.querySelector('button[aria-label=${JSON.stringify(`Try ${HOST_LABEL} now`)}]')`

/** The Repositories button on the host's card. */
const REPOSITORIES_BUTTON =
  `const li = ${TRY_NOW}?.closest('li')
   return [...(li?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().startsWith('Repositories'))`

/**
 * Reach the tailnet host before anything records, and learn its route.
 *
 * A seeded host is a description of a machine, not a known one: `#/h/<id>/`
 * needs the instance id the machine reports on first connect, and the Hosts
 * screen does not connect to anything on its own. "Try now" is the deliberate
 * reach, so the warm-up presses it, waits for the card to say "Reachable", and
 * only then can the Repositories button exist for the clip to click.
 */
async function reachHost(cdp) {
  await goTo(cdp, '#/hosts')
  const tryNow = await locate(cdp, `return ${TRY_NOW}`)
  if (!tryNow) throw new Error(`No host labelled ${HOST_LABEL} on the Hosts screen; seed with DEMO_TAILNET_HOST`)
  await plainClick(cdp, tryNow)

  const deadline = Date.now() + 30_000
  let text = ''
  while (Date.now() < deadline) {
    text = (await cdp.evaluate(`${TRY_NOW}?.closest('li')?.innerText ?? ''`)) ?? ''
    if (/\bReachable\b/.test(text) && !/Unreachable|Checking/.test(text)) break
    await wait(400)
  }
  if (!/\bReachable\b/.test(text) || /Unreachable/.test(text)) {
    throw new Error(`${HOST_LABEL} did not become reachable:\n${text}`)
  }
  if (/available/.test(text)) {
    throw new Error(
      `${HOST_LABEL} runs a different GitWarren than this serve claims to be, and its card offers an ` +
        `update. Start serve with __APP_VERSION__ set to the host's version (see the header).\n${text}`
    )
  }
  await settle(cdp)

  const repositories = await locateOrFail(cdp, REPOSITORIES_BUTTON, `the Repositories button on ${HOST_LABEL}'s card`)
  await plainClick(cdp, repositories)
  await wait(400)
  await settle(cdp)
  const hostRoute = await cdp.evaluate('location.hash')
  if (!/^#\/h\//.test(hostRoute)) throw new Error(`Repositories did not lead to a host route (got ${hostRoute})`)
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

  // Unfolded gaps and the open file survive a hash change, so a second take in
  // the same tab would start where the first one finished. Reload instead: this
  // clip writes nothing, so the page is the only state a take has.
  await cdp.send('Page.reload', { ignoreCache: false })
  await wait(2500)
  await settle(cdp)
  await hideScrollbars(cdp)
  await install(cdp)

  // Warm every screen before recording, so the clip shows the product rather
  // than a skeleton while git - or another machine - is asked a question.
  await reachHost(cdp)
  await goTo(cdp, `#/reviews/${REVIEW_ID}/browse/${encodeURIComponent(UNTOUCHED_FILE)}`)
  await wait(800)
  await goTo(cdp, `#/reviews/${REVIEW_ID}/files`)
  await wait(800)

  const folded = await countExpanders(cdp, CHANGED_FILE)
  if (folded < 1) throw new Error(`${CHANGED_FILE} has nothing folded; the clip has no point to make`)

  await parkCursor(cdp, SIZE)
  await caption(cdp, null)
  await scrollMain(cdp, { top: 0, behavior: 'instant' })
  await wait(600)

  const recorder = new Recorder(cdp, { frameDir: FRAME_DIR, size: SIZE, scale: SCALE, fps: FPS })
  await recorder.start()

  // Every beat ends at a fixed second from here; see the header.
  const startedAt = Date.now()
  const until = (seconds) => wait(Math.max(0, startedAt + seconds * 1000 - Date.now()))

  // 1. What is under review: an agent's work, still uncommitted.
  await caption(cdp, "Reviewing an agent's work — before it's committed")
  await until(2.4)

  // 2. The change set, and only the change set - three lines of context, and
  //    the rest of the file folded away behind the expanders.
  await scrollToFile(cdp, CHANGED_FILE)
  await caption(cdp, 'The diff alone: 3 lines of context, the rest folded away')
  await until(5.4)

  // 3. The first half of the answer: the file, whole, with the change in it.
  const expandAll = await locateOrFail(
    cdp,
    `return ${fileCard(CHANGED_FILE)}?.querySelector('button[aria-label="Expand all lines in this file"]')`,
    'the "Expand all lines" button'
  )
  await cursorTo(cdp, expandAll.x, expandAll.y)
  await wait(200)
  await clickAt(cdp, expandAll.x, expandAll.y)
  await caption(cdp, 'Expand all lines — the whole file, change in place')
  await wait(500)
  const left = await countExpanders(cdp, CHANGED_FILE)
  if (left !== 0) throw new Error(`Expand all left ${left} gaps folded`)
  await parkCursor(cdp, SIZE)
  await until(9.0)

  // 4. Reading down through context that was never in the diff.
  await cdp.evaluate(`document.querySelector('main')?.scrollBy({ top: 560, behavior: 'smooth' })`)
  await caption(cdp, 'Read around the change, not just the hunk')
  await until(11.4)

  // 5. The second half: the tab that reaches a file the change never touched.
  //    Back up to the top first, where the tabs are.
  await scrollMain(cdp, { top: 0, behavior: 'smooth' })
  await wait(650)
  const browseTab = await locateOrFail(
    cdp,
    `return [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().startsWith('Browse files'))`,
    'the "Browse files" tab'
  )
  await caption(cdp, "Browse files — anything the change didn't touch")
  await cursorTo(cdp, browseTab.x, browseTab.y)
  await wait(150)
  await clickAt(cdp, browseTab.x, browseTab.y)
  await wait(300)
  await settle(cdp, { timeout: 4000 })
  await until(14.0)

  // 6. And there it is - the conversation tab, which the branch's own registry
  //    declares a scope for and never binds. Found the way a person finds a
  //    file in an unfamiliar tree: by typing part of its name.
  const filter = await locateOrFail(
    cdp,
    `return document.querySelector('input[aria-label="Filter files in this repository"]')`,
    'the file filter'
  )
  await caption(cdp, 'Any file in the repo — touched by the change or not')
  await cursorTo(cdp, filter.x, filter.y)
  await clickAt(cdp, filter.x, filter.y)
  await type(cdp, UNTOUCHED_FILTER)
  await wait(150)
  const match = await locateOrFail(
    cdp,
    `return document.querySelector('nav[aria-label="Matching files"] button[title^=${JSON.stringify(UNTOUCHED_FILE)}]')`,
    `${UNTOUCHED_FILE} among the matches`
  )
  await cursorTo(cdp, match.x, match.y)
  await wait(150)
  await clickAt(cdp, match.x, match.y)
  await parkCursor(cdp, SIZE)
  await wait(300)
  await settle(cdp, { timeout: 4000 })
  await scrollMain(cdp, { top: 0, behavior: 'instant' })
  await until(18.4)

  // 7. The other half of his setup: a stack of machines on a tailnet. The card
  //    is a real host, reached for real a moment ago.
  await caption(cdp, 'Your other machines, over your tailnet')
  await goTo(cdp, '#/hosts')
  await scrollMain(cdp, { top: 0, behavior: 'instant' })
  await until(21.4)

  // 8. Into that machine: its repositories, from here.
  const repos = await locateOrFail(cdp, REPOSITORIES_BUTTON, `the Repositories button on ${HOST_LABEL}'s card`)
  await caption(cdp, 'Review what your agents did there — from here')
  await cursorTo(cdp, repos.x, repos.y)
  await wait(150)
  await clickAt(cdp, repos.x, repos.y)
  await parkCursor(cdp, SIZE)
  await wait(300)
  await settle(cdp, { timeout: 4000 })
  await until(25.0)

  // 9. Where to get it.
  await caption(cdp, 'gitwarren.com — open source, runs on your machines')
  await until(27.2)

  await recorder.stop()
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()

  await encode(recorder, { outDir: OUT_DIR, name: 'dhh-clip', loopFade: null, width: OUTPUT_WIDTH })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
