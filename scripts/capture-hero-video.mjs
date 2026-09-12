/**
 * Record the landing page's hero video by driving the running app over the
 * Chrome DevTools Protocol.
 *
 * The same reasoning as capture-demo.mjs, applied to motion: no Screen
 * Recording permission, nothing on the desktop but the app, an exact viewport
 * at a guaranteed 2x - and, because the whole sequence is scripted, the video
 * can be re-recorded in one command every time the UI changes. There is no
 * cursor in the recording on purpose. The storyboard is driven from the
 * keyboard wherever the app allows it, and the one pointer gesture (opening a
 * line comment) shows its hover state without a pointer to explain it.
 *
 * The story, in about twenty seconds:
 *
 *   1. A review that already includes uncommitted work: the amber badge, the
 *      "1 staged, 1 unstaged, 1 untracked" banner.
 *   2. `u` folds the working tree out - this is what every other tool shows -
 *      and back in.
 *   3. `]` steps to a file that exists only on disk.
 *   4. A line comment is written on it.
 *   5. The agent's reply lands, with the (AI) attribution.
 *
 * Then a short crossfade back to the first frame, so it loops.
 *
 * Setup - the demo repositories, a seeded database and a running app:
 *
 *   DEMO_REPO_ROOT=~/Developer/klarluft scripts/make-demo-repos.sh
 *   rm -rf /tmp/gw-demo
 *   GITWARREN_DATA_DIR=/tmp/gw-demo DEMO_REPO_ROOT=~/Developer/klarluft npx tsx scripts/seed-demo.ts
 *   npx electron-vite build
 *   GITWARREN_DATA_DIR=/tmp/gw-demo ./node_modules/.bin/electron . --remote-debugging-port=9222
 *
 * Then, from another terminal (ffmpeg must be on PATH):
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-demo node scripts/capture-hero-video.mjs
 *
 * The repository path in the banner is part of the picture, which is why the
 * setup above puts the demo under ~/Developer rather than /tmp.
 *
 * Outputs land in VIDEO_DIR (default: a gitignored `video-out/`). The videos
 * are site assets and belong in the site repository:
 *
 *   VIDEO_DIR=~/github.com/klarluft/gitwarren-site/src/assets
 *
 * which writes hero.mp4, hero.webm and hero.png (the poster: the first frame,
 * so the poster and the video start identical).
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, hideScrollbars, settle, wait } from './cdp.mjs'
import { Recorder, encode } from './record.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = process.env.VIDEO_DIR ?? 'video-out'
const FRAME_DIR = join(tmpdir(), 'gitwarren-hero-frames')

/** The same frame as the hero screenshot: 3:2 at 2x. */
const SIZE = { width: 1200, height: 800 }
const SCALE = 2
const FPS = 30
/** How long the crossfade back to the opening frame takes. */
const LOOP_FADE_SECONDS = 0.6

const REVIEW_ID = Number(process.env.DEMO_REVIEW_ID ?? 1)
/** The untracked file in the seeded review, and the line the comment goes on. */
const HELP_FILE = 'src/renderer/src/features/reviews/shortcut-help.tsx'
const COMMENT_LINE_TEXT = "import { Dialog, DialogContent"
const COMMENT = 'Does this need its own Escape handling, or does the dialog already close on it?'
const REPLY =
  "Base UI's `Dialog` closes on Escape by itself, so no. But the registry keeps listening while " +
  'the overlay is open: `?` pressed twice fires the shortcut behind it. Worth a `[role="dialog"]` ' +
  'check in `onKeyDown` before it dispatches.'

// ---- input ------------------------------------------------------------------

/** A bare key press, as the hotkey layer sees it. Never inserts text. */
async function press(cdp, key, code, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
}

/** Type into whatever has focus, at a human-looking, slightly uneven pace. */
async function type(cdp, text) {
  for (const character of text) {
    await cdp.send('Input.insertText', { text: character })
    // Word boundaries take a beat longer, the way real typing does.
    await wait(character === ' ' ? 70 : 28 + Math.random() * 24)
  }
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

/**
 * Where a diff line and its comment button are.
 *
 * The button only has a box while its row is hovered, so this is asked twice:
 * once for the row, and again after the pointer is over it.
 */
async function locateLine(cdp, file, needle) {
  const found = await cdp.evaluate(`(() => {
    const card = document.getElementById('file-' + encodeURIComponent(${JSON.stringify(file)}))
    if (!card) return null
    const span = [...card.querySelectorAll('span.whitespace-pre')].find((node) =>
      node.textContent.includes(${JSON.stringify(needle)})
    )
    if (!span) return null
    const row = span.parentElement
    const rect = (node) => {
      const r = node.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, left: r.left }
    }
    const button = row.querySelector('button[aria-label^="Comment on line"]')
    return { row: rect(row), button: button && button.offsetParent !== null ? rect(button) : null }
  })()`)
  if (!found) throw new Error(`Cannot find "${needle}" in ${file} on screen`)
  return found
}

async function submitComposer(cdp) {
  const result = await cdp.evaluate(`(() => {
    let node = document.activeElement
    while (node && node !== document.body) {
      const button = [...node.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Comment')
      if (button) {
        button.click()
        return 'ok'
      }
      node = node.parentElement
    }
    return 'no composer around the focused element'
  })()`)
  if (result !== 'ok') throw new Error(result)
}

/**
 * Ask SWR to re-read the comments now rather than on its 15s clock, and wait
 * until the given text is actually on screen.
 *
 * A single synthetic focus event is not always honoured, so this keeps asking
 * until the reply shows up; the worst case is one 15s refresh tick, which the
 * recording would survive but the loop would not enjoy.
 */
async function waitForText(cdp, text, { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await cdp.evaluate(`(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      return 'ok'
    })()`)
    await wait(250)
    const shown = await cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)
    if (shown) return
  }
  throw new Error(`"${text}" never appeared on screen`)
}

// ---- the agent -------------------------------------------------------------

/**
 * The reply is written by a separate process through the same service the
 * MCP server uses, so it carries real agent attribution. The process is
 * started early and waits for a cue, so the reply lands the moment it is asked
 * for rather than after a second of tsx start-up.
 */
function startAgent() {
  if (!process.env.GITWARREN_DATA_DIR) {
    throw new Error('Set GITWARREN_DATA_DIR to the database the app is running against.')
  }
  const child = spawn('npx', ['tsx', 'scripts/demo-agent-reply.ts'], {
    env: {
      ...process.env,
      DEMO_REVIEW_ID: String(REVIEW_ID),
      DEMO_FILE_PATH: HELP_FILE,
      DEMO_REPLY_BODY: REPLY
    },
    stdio: ['pipe', 'inherit', 'inherit']
  })
  const done = new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`agent reply exited ${code}`))))
  })
  return {
    reply: () => {
      child.stdin.write('go\n')
      child.stdin.end()
      return done
    }
  }
}

// ---- the storyboard ----------------------------------------------------------

async function main() {
  const agent = startAgent()
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

  await cdp.evaluate(`location.hash = ${JSON.stringify(`#/reviews/${REVIEW_ID}/files`)}`)
  await wait(300)
  await settle(cdp)

  // Warm both diffs so `u` flips between two cached answers instead of showing
  // a skeleton while git is asked again; the recording should show the
  // product, not the fetch.
  await press(cdp, 'u', 'KeyU', 85)
  await settle(cdp)
  await press(cdp, 'u', 'KeyU', 85)
  await settle(cdp)

  // Park the pointer where it hovers nothing, and start from the top.
  await moveMouse(cdp, SIZE.width - 12, SIZE.height - 12)
  await cdp.evaluate(`document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' })`)
  await wait(600)

  const recorder = new Recorder(cdp, { frameDir: FRAME_DIR, size: SIZE, scale: SCALE, fps: FPS })
  await recorder.start()

  // 1. The review as it is: uncommitted work already folded in.
  await wait(2600)

  // 2. Without the working tree, and with it again.
  await press(cdp, 'u', 'KeyU', 85)
  await wait(1900)
  await press(cdp, 'u', 'KeyU', 85)
  await wait(1700)

  // 3. On to the file that is not a commit yet.
  await press(cdp, ']', 'BracketRight', 221)
  await wait(2600)

  // 4. A comment on one of its lines.
  const line = await locateLine(cdp, HELP_FILE, COMMENT_LINE_TEXT)
  await moveMouse(cdp, line.row.left + 40, line.row.y)
  await wait(500)
  const hovered = await locateLine(cdp, HELP_FILE, COMMENT_LINE_TEXT)
  if (!hovered.button) throw new Error('The comment button did not appear on hover')
  await click(cdp, hovered.button.x, hovered.button.y)
  await wait(900)
  await type(cdp, COMMENT)
  await wait(700)
  await submitComposer(cdp)
  recorder.mark('posted')
  await wait(1500)

  // 5. The agent answers. However long the refresh takes, the cut shows the
  //    posted comment for a beat and then the reply.
  await agent.reply()
  await waitForText(cdp, 'closes on Escape by itself')
  recorder.mark('replied')
  recorder.squeeze('posted', 'replied', 1.4)
  await wait(3000)

  await recorder.stop()
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()

  await encode(recorder, { outDir: OUT_DIR, name: 'hero', loopFade: LOOP_FADE_SECONDS })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
