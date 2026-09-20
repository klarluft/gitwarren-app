/**
 * The product beats of the ad, one clip each, recorded from the browser shell.
 *
 * The storyboard is `storyboard.md` next to this file. A video model makes the
 * people; this makes every frame the product is in. Each beat is its own
 * recording and its own file, because the cut is made in an editor against a
 * voice-over, and an editor wants clips it can slide, not one long take to
 * carve. Nothing here is a caption: the words on screen in the finished piece
 * are the voice-over's, burned in at the edit, and a clip that carried its own
 * would fight them. The pointer is drawn, though - a screencast has none, and a
 * click with no pointer reads as a screen that changed for no reason.
 *
 * Beats, in storyboard order (the seconds are where the cut wants them; the
 * clips run a little longer so the edit has handles):
 *
 *   review-opens        0:18  the review, uncommitted badge and all, held
 *   scroll-diff         0:22  down through the change
 *   comment-and-reply   0:26  a line comment typed and posted; the agent answers
 *   browse-untouched    0:32  Browse files, filter, a file the change never
 *                             touched, a comment on a line of it, the answer
 *   hosts               0:36  the Hosts screen, pc-win reachable, its repositories
 *   conversation        -     the discussion tab (B-roll; not in the storyboard)
 *   home                -     the repositories screen (B-roll)
 *
 * Every beat ends at a fixed second from its own first frame, as in
 * `capture-dhh-clip.mjs`: the overhead of a glide or a settle comes out of the
 * hold, never the total.
 *
 * ## Setup
 *
 * The demo repositories, a seeded database, the web build, `serve` on a moved
 * port, a Chrome with a debugging port, and pc-win running GitWarren - all of
 * it is written down under "Product captures" in `storyboard.md`. In short:
 *
 *   DEMO_REPO_ROOT=~/Developer/klarluft scripts/make-demo-repos.sh
 *   GITWARREN_DATA_DIR=<dir> DEMO_REPO_ROOT=~/Developer/klarluft \
 *     DEMO_TAILNET_HOST=pc-win.tail688c0c.ts.net:41427 npx tsx scripts/seed-demo.ts
 *   npm run build:web            # with LINK_SERVER_PORT moved to 41428
 *   GITWARREN_DATA_DIR=<dir> APP_VERSION=<pc-win's> scripts/ad/serve.sh
 *   scripts/ad/chrome.sh '<the URL serve printed>'
 *   GITWARREN_DATA_DIR=<dir> node scripts/ad/capture-ad.mjs [beat ...]
 *
 * With no beat names every beat is recorded. Two of them post comments, so a
 * second take of those wants a reseed (and a restarted serve, which holds the
 * database open).
 *
 * Outputs land in VIDEO_DIR (default: the gitignored `video-out/ad/`) as
 * `<beat>.mp4`, 1920x1080.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, hideScrollbars, settle, wait } from '../cdp.mjs'
import { clickAt, cursorTo, install, parkCursor } from '../overlay.mjs'
import { Recorder, encode } from '../record.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
const OUT_DIR = process.env.VIDEO_DIR ?? 'video-out/ad'
const FRAME_ROOT = join(tmpdir(), 'gitwarren-ad-frames')

/** 16:9, shot at 1120 wide and delivered at 1920, as the DHH clip was. */
const SIZE = { width: 1120, height: 630 }
const SCALE = 2
const FPS = 30
const OUTPUT_WIDTH = 1920

const REVIEW_ID = Number(process.env.DEMO_REVIEW_ID ?? 1)
const HOST_LABEL = process.env.DEMO_TAILNET_LABEL ?? 'pc-win'

/** The untracked file in the seeded review: a change that is not a commit yet. */
const HELP_FILE = 'src/renderer/src/features/reviews/shortcut-help.tsx'
const HELP_LINE = 'import { Dialog, DialogContent'
const HELP_COMMENT = 'Does this need its own Escape handling, or does the dialog already close on it?'
const HELP_REPLY =
  "Base UI's `Dialog` closes on Escape by itself, so no. But the registry keeps listening while " +
  'the overlay is open: `?` pressed twice fires the shortcut behind it. Worth a `[role="dialog"]` ' +
  'check in `onKeyDown` before it dispatches.'

/**
 * The file the change never touched. The branch's registry declares a scope
 * for the conversation tab and binds nothing to it; this is where the missing
 * half would go, and the diff does not point at it.
 */
const UNTOUCHED_FILE = 'src/renderer/src/features/reviews/review-conversation-tab.tsx'
const UNTOUCHED_FILTER = 'conversation-tab'
const UNTOUCHED_LINE = 'export function ReviewConversationTab'
const UNTOUCHED_COMMENT = 'The registry declares a conversation scope and nothing in here binds it. Intended?'
const UNTOUCHED_REPLY =
  "Not intended - `shortcuts.ts` declares the scope and this tab never registers under it. I'll bind " +
  '`n`/`p` to step through threads here, in this change.'

// ---- input -------------------------------------------------------------------

/** Type into whatever has focus, at a human-looking, slightly uneven pace. */
async function type(cdp, text) {
  for (const character of text) {
    await cdp.send('Input.insertText', { text: character })
    await wait(character === ' ' ? 40 : 14 + Math.random() * 16)
  }
}

/** A click with the real pointer only: for the warm-up, where nothing records. */
async function plainClick(cdp, { x, y }) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// ---- the page ----------------------------------------------------------------

/**
 * Make the compositor draw a frame now.
 *
 * A screencast frame arrives only when something on screen changed, so a
 * beat that holds a still page records nothing - and a clip needs a frame at
 * its first instant and one at its last, or their durations are guesswork.
 * A transparent pixel whose opacity flips is a change the compositor sees and
 * a viewer cannot.
 */
async function pulse(cdp) {
  await cdp.evaluate(`(() => {
    let el = document.getElementById('gw-clip-pulse')
    if (!el) {
      el = document.createElement('div')
      el.id = 'gw-clip-pulse'
      el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;background:#000;pointer-events:none;z-index:2147483646;opacity:0.002'
      document.body.appendChild(el)
    }
    el.style.opacity = el.style.opacity === '0.002' ? '0.004' : '0.002'
    return 'ok'
  })()`)
  await wait(80)
}

/** The centre of the first on-screen element an expression finds, or null. */
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

async function goTo(cdp, hash) {
  await cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`)
  await wait(300)
  await settle(cdp)
}

function scrollMain(cdp, options) {
  return cdp.evaluate(`document.querySelector('main')?.scrollTo(${JSON.stringify(options)})`)
}

/** Put a file's card at the top of the page, the way clicking the tree does. */
async function scrollToFile(cdp, file) {
  const found = await cdp.evaluate(`(() => {
    const card = ${fileCard(file)}
    if (!card) return null
    card.scrollIntoView({ block: 'start', behavior: 'instant' })
    return 'ok'
  })()`)
  if (found !== 'ok') throw new Error(`No card for ${file} on screen`)
}

/**
 * Where a diff line and its comment button are, inside `scope` (a file card on
 * the files tab; `main` on the browse tab, which has no cards).
 *
 * The button only has a box while its row is hovered, so this is asked twice:
 * once for the row, and again after the pointer is over it.
 */
async function locateLine(cdp, scope, needle) {
  const found = await cdp.evaluate(`(() => {
    const scope = ${scope}
    if (!scope) return null
    const span = [...scope.querySelectorAll('span.whitespace-pre')].find((node) =>
      node.textContent.includes(${JSON.stringify(needle)})
    )
    if (!span) return null
    const row = span.parentElement
    const rect = (node) => {
      const r = node.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top }
    }
    const button = row.querySelector('button[aria-label^="Comment on line"]')
    return { row: rect(row), button: button && button.offsetParent !== null ? rect(button) : null }
  })()`)
  if (!found) throw new Error(`Cannot find "${needle}" on screen`)
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
 * Ask SWR to re-read the comments now rather than on its clock, and wait until
 * the given text is actually on screen.
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

function tab(label) {
  return `return [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim().startsWith(${JSON.stringify(label)}))`
}

// ---- the agent ---------------------------------------------------------------

/**
 * The reply is written by a separate process through the same service the MCP
 * server uses, so it carries real agent attribution. Started early and cued
 * later, so tsx start-up stays out of the recording.
 */
function startAgent(file, body) {
  if (!process.env.GITWARREN_DATA_DIR) {
    throw new Error('Set GITWARREN_DATA_DIR to the database serve is running against.')
  }
  const child = spawn('npx', ['tsx', 'scripts/demo-agent-reply.ts'], {
    env: { ...process.env, DEMO_REVIEW_ID: String(REVIEW_ID), DEMO_FILE_PATH: file, DEMO_REPLY_BODY: body },
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
    },
    cancel: () => child.kill()
  }
}

/** Hover a line, click its comment button, type, post, and have the agent answer. */
async function commentAndReply(cdp, { scope, needle, comment, agent, replyText, recorder, hold = 2200 }) {
  const line = await locateLine(cdp, scope, needle)
  await cursorTo(cdp, line.row.left + 40, line.row.y)
  await wait(300)
  const hovered = await locateLine(cdp, scope, needle)
  if (!hovered.button) throw new Error('The comment button did not appear on hover')
  await cursorTo(cdp, hovered.button.x, hovered.button.y)
  await wait(120)
  await clickAt(cdp, hovered.button.x, hovered.button.y)
  await wait(500)
  await parkCursor(cdp, SIZE)
  await type(cdp, comment)
  await wait(350)
  await submitComposer(cdp)
  recorder.mark('posted')
  await wait(600)

  // However long the refresh takes, the cut shows the posted comment for a
  // beat and then the reply.
  await agent.reply()
  await waitForText(cdp, replyText)
  recorder.mark('replied')
  recorder.squeeze('posted', 'replied', 0.9)
  // A fixed hold from here, not a point on the clock: the squeeze above
  // shortens everything before it, and a hold measured from the start would
  // leave the reply on screen for however little was left.
  await wait(hold)
}

// ---- hosts -------------------------------------------------------------------

const TRY_NOW = `document.querySelector('button[aria-label=${JSON.stringify(`Try ${HOST_LABEL} now`)}]')`

/** The Repositories button on the host's card. */
const REPOSITORIES_BUTTON =
  `const li = ${TRY_NOW}?.closest('li')
   return [...(li?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().startsWith('Repositories'))`

/**
 * Reach the tailnet host before anything records. A seeded host is a
 * description of a machine, not a known one: "Try now" is the deliberate reach,
 * and only once the card says "Reachable" can Repositories lead anywhere.
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
        `update. Start serve with APP_VERSION set to the host's version (see serve.sh).\n${text}`
    )
  }
  await settle(cdp)

  // Warm the host's repositories screen too, then come back.
  const repositories = await locateOrFail(cdp, REPOSITORIES_BUTTON, `the Repositories button on ${HOST_LABEL}'s card`)
  await plainClick(cdp, repositories)
  await wait(400)
  await settle(cdp)
  const hostRoute = await cdp.evaluate('location.hash')
  if (!/^#\/h\//.test(hostRoute)) throw new Error(`Repositories did not lead to a host route (got ${hostRoute})`)
  await goTo(cdp, '#/hosts')
}

// ---- the beats ---------------------------------------------------------------

const FILES = `#/reviews/${REVIEW_ID}/files`

const BEATS = {
  /** 0:18 - the review, as the link opens it. Held; the edit fades it in. */
  async 'review-opens'(cdp, { until }) {
    await until(5)
  },

  /** 0:22 - down through the change. */
  async 'scroll-diff'(cdp, { until }) {
    await until(0.6)
    await cdp.evaluate(`document.querySelector('main')?.scrollBy({ top: 620, behavior: 'smooth' })`)
    await until(2.6)
    await cdp.evaluate(`document.querySelector('main')?.scrollBy({ top: 620, behavior: 'smooth' })`)
    await until(5)
  },

  /** 0:26 - a comment on a line of the file that is not a commit yet; the agent answers. */
  async 'comment-and-reply'(cdp, { recorder, until }) {
    const agent = startAgent(HELP_FILE, HELP_REPLY)
    try {
      await until(0.4)
      await commentAndReply(cdp, {
        scope: fileCard(HELP_FILE),
        needle: HELP_LINE,
        comment: HELP_COMMENT,
        agent,
        replyText: 'closes on Escape by itself',
        recorder
      })
    } finally {
      agent.cancel()
    }
  },

  /** 0:32 - Browse files, a file the change never touched, a comment on it. */
  async 'browse-untouched'(cdp, { recorder, until }) {
    const agent = startAgent(UNTOUCHED_FILE, UNTOUCHED_REPLY)
    try {
      await until(0.4)
      const browse = await locateOrFail(cdp, tab('Browse files'), 'the "Browse files" tab')
      await cursorTo(cdp, browse.x, browse.y)
      await wait(120)
      await clickAt(cdp, browse.x, browse.y)
      await wait(300)
      await settle(cdp, { timeout: 4000 })
      await until(1.8)

      const filter = await locateOrFail(
        cdp,
        `return document.querySelector('input[aria-label="Filter files in this repository"]')`,
        'the file filter'
      )
      await cursorTo(cdp, filter.x, filter.y)
      await clickAt(cdp, filter.x, filter.y)
      await type(cdp, UNTOUCHED_FILTER)
      await wait(200)
      const match = await locateOrFail(
        cdp,
        `return document.querySelector('nav[aria-label="Matching files"] button[title^=${JSON.stringify(UNTOUCHED_FILE)}]')`,
        `${UNTOUCHED_FILE} among the matches`
      )
      await cursorTo(cdp, match.x, match.y)
      await wait(120)
      await clickAt(cdp, match.x, match.y)
      await wait(300)
      await settle(cdp, { timeout: 4000 })
      await until(4.2)

      // The line is well down the file; bring it into view first. A jump, not
      // a glide: a smooth scroll over a long file is still moving when the
      // row is measured for the hover, and the pointer lands on the wrong line.
      await cdp.evaluate(`(() => {
        const span = [...document.querySelectorAll('main span.whitespace-pre')].find((n) => n.textContent.includes(${JSON.stringify(UNTOUCHED_LINE)}))
        span?.parentElement?.scrollIntoView({ block: 'center', behavior: 'instant' })
      })()`)
      await until(5.2)
      await commentAndReply(cdp, {
        scope: `document.querySelector('main')`,
        needle: UNTOUCHED_LINE,
        comment: UNTOUCHED_COMMENT,
        agent,
        replyText: 'never registers under it',
        recorder
      })
    } finally {
      agent.cancel()
    }
  },

  /** 0:36 - the Hosts screen: pc-win, reached for real, then its repositories from here. */
  async hosts(cdp, { until }) {
    await until(2.2)
    const repos = await locateOrFail(cdp, REPOSITORIES_BUTTON, `the Repositories button on ${HOST_LABEL}'s card`)
    await cursorTo(cdp, repos.x, repos.y)
    await wait(150)
    await clickAt(cdp, repos.x, repos.y)
    await parkCursor(cdp, SIZE)
    await wait(300)
    await settle(cdp, { timeout: 4000 })
    await until(6)
  },

  /** B-roll: the conversation tab, read slowly. */
  async conversation(cdp, { until }) {
    await until(1.2)
    await cdp.evaluate(`document.querySelector('main')?.scrollBy({ top: 420, behavior: 'smooth' })`)
    await until(5)
  },

  /** B-roll: the repositories screen. */
  async home(cdp, { until }) {
    await until(4)
  }
}

/** Where each beat starts from - set up before the recording begins. */
const OPENINGS = {
  async 'review-opens'(cdp) {
    await goTo(cdp, FILES)
    await scrollMain(cdp, { top: 0, behavior: 'instant' })
  },
  async 'scroll-diff'(cdp) {
    await goTo(cdp, FILES)
    await scrollMain(cdp, { top: 0, behavior: 'instant' })
  },
  async 'comment-and-reply'(cdp) {
    await goTo(cdp, FILES)
    await scrollToFile(cdp, HELP_FILE)
  },
  async 'browse-untouched'(cdp) {
    await goTo(cdp, FILES)
    await scrollMain(cdp, { top: 0, behavior: 'instant' })
  },
  async hosts(cdp) {
    await goTo(cdp, '#/hosts')
    await scrollMain(cdp, { top: 0, behavior: 'instant' })
  },
  async conversation(cdp) {
    await goTo(cdp, FILES)
    const conversation = await locateOrFail(cdp, tab('Conversation'), 'the "Conversation" tab')
    await plainClick(cdp, conversation)
    await wait(300)
    await settle(cdp)
    await scrollMain(cdp, { top: 0, behavior: 'instant' })
  },
  async home(cdp) {
    await goTo(cdp, '#/')
    await scrollMain(cdp, { top: 0, behavior: 'instant' })
  }
}

async function record(cdp, name) {
  await OPENINGS[name](cdp)
  await parkCursor(cdp, SIZE)
  await wait(700)

  const recorder = new Recorder(cdp, { frameDir: join(FRAME_ROOT, name), size: SIZE, scale: SCALE, fps: FPS })
  await recorder.start()
  const startedAt = Date.now()
  const until = (seconds) => wait(Math.max(0, startedAt + seconds * 1000 - Date.now()))
  try {
    await pulse(cdp)
    await BEATS[name](cdp, { recorder, until })
    await pulse(cdp)
  } finally {
    await recorder.stop()
  }
  console.log(`${name}:`)
  await encode(recorder, { outDir: OUT_DIR, name, width: OUTPUT_WIDTH, poster: false, webm: false })
}

async function main() {
  const wanted = process.argv.slice(2)
  const names = wanted.length ? wanted : Object.keys(BEATS)
  for (const name of names) if (!BEATS[name]) throw new Error(`No beat named ${name}. Have: ${Object.keys(BEATS).join(', ')}`)

  const cdp = await Cdp.attach(PORT)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: SIZE.width,
    height: SIZE.height,
    deviceScaleFactor: SCALE,
    mobile: false
  })
  await cdp.send('Page.reload', { ignoreCache: false })
  await wait(2500)
  await settle(cdp)
  await hideScrollbars(cdp)
  await install(cdp)

  // The desktop window's drag strip is rendered in the browser shell too, as
  // an empty band above the page; a clip has no window controls to make room
  // for, so the product gets the height back.
  await cdp.evaluate(`(() => {
    const style = document.createElement('style')
    style.textContent = '.titlebar-drag{display:none!important}'
    document.head.appendChild(style)
    return 'ok'
  })()`)

  // Warm every screen a beat will show, so the clips show the product rather
  // than a skeleton while git - or another machine - is asked a question.
  if (names.includes('hosts')) await reachHost(cdp)
  await goTo(cdp, `#/reviews/${REVIEW_ID}/browse/${encodeURIComponent(UNTOUCHED_FILE)}`)
  await wait(600)
  await goTo(cdp, FILES)
  await wait(600)

  for (const name of names) await record(cdp, name)

  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
