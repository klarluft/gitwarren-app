/**
 * Capture product screenshots by driving the running app over the Chrome
 * DevTools Protocol.
 *
 * Deliberately not `screencapture(1)`: an OS-level grab needs Screen Recording
 * permission, catches whatever else is on the desktop, and pins the image to
 * whatever size the window happened to be. Talking to the renderer instead
 * gives an exact viewport, a guaranteed 2x pixel ratio, and a frame that
 * contains nothing but the app.
 *
 * Start the app with a debugging port first:
 *
 *   npx electron-vite build
 *   GITWARREN_DATA_DIR=/tmp/gw-demo ./node_modules/.bin/electron . --remote-debugging-port=9222
 *   node scripts/capture-demo.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Cdp, hideScrollbars, settle, wait } from './cdp.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9222)
/**
 * Where the PNGs land. The images are marketing assets and live in the site
 * repository, not here - point `SHOT_DIR` at it:
 *
 *   SHOT_DIR=~/github.com/klarluft/gitwarren-site/design/screenshots
 *
 * The default is a gitignored scratch directory, so a run without it does not
 * quietly start collecting design output in this repository.
 */
const OUT_DIR = process.env.SHOT_DIR ?? 'screenshots-out'

/**
 * Two sizes, and the reasoning behind both.
 *
 * `wide` is 1200x800. The review screen caps its content at `max-w-5xl`
 * (1024px), so a wider frame buys empty gutters rather than more app; 3:2 is
 * also the shape a desktop window actually is, which keeps the hero honest.
 *
 * `narrow` is 760x900 - portrait, for the point in a responsive layout where a
 * 1200px-wide image would shrink to unreadable. Cropping a tall slice keeps the
 * type legible instead.
 */
const WIDE = { width: 1200, height: 800 }
const NARROW = { width: 760, height: 900 }

const SHOTS = [
  {
    name: '01-review-files-uncommitted',
    hash: '#/reviews/1/files',
    size: WIDE,
    note: 'The hero: a diff with committed, staged, unstaged and untracked work folded together.'
  },
  {
    name: '02-review-conversation',
    hash: '#/reviews/1/conversation',
    size: WIDE,
    note: 'Human and agent in one thread, with the (AI) attribution visible.'
  },
  {
    name: '03-repository-reviews',
    hash: '#/repositories/1',
    size: WIDE,
    note: 'Reviews against one repository, open and closed.'
  },
  {
    name: '04-home-repositories',
    hash: '#/',
    size: WIDE,
    note: 'The entry point, including the agent access panel.'
  },
  {
    name: '11-agent-access',
    hash: '#/',
    size: WIDE,
    // The panel is collapsed by default. Open it: the MCP block it prints is
    // the concrete answer to "how do my agents get at this".
    click: 'text:Agent access',
    note: 'The MCP server config, as the app prints it for this install.'
  },
  {
    name: '05-review-commits',
    hash: '#/reviews/1/commits',
    size: WIDE,
    note: 'The commits tab.'
  },
  {
    name: '08-agent-thread',
    hash: '#/reviews/1/conversation',
    size: WIDE,
    // The whole exchange rather than the top of the page: an agent finding
    // something real, and a human answering it, is the section this shot is for.
    scrollTo: 'text:This misses one case worth covering',
    offset: -120,
    note: 'Agent review comment and the human reply, in full.'
  },
  {
    name: '09-untracked-file',
    hash: '#/reviews/1/files',
    size: WIDE,
    scrollTo: 'file:src/renderer/src/features/reviews/shortcut-help.tsx',
    offset: -40,
    note: 'A file that exists only in the working tree, reviewed before it is a commit.'
  },
  {
    name: '10-inline-thread',
    hash: '#/reviews/1/files',
    size: WIDE,
    scrollTo: 'file:src/renderer/src/features/reviews/review-files-tab.tsx',
    offset: -40,
    note: 'Additions and deletions together, with a line comment anchored inline.'
  },
  {
    name: '06-conversation-narrow',
    hash: '#/reviews/1/conversation',
    size: NARROW,
    note: 'Portrait crop for the mobile breakpoint of the landing page.'
  },
  {
    name: '07-files-narrow',
    hash: '#/reviews/1/files',
    size: NARROW,
    note: 'Portrait crop of the diff.'
  }
]

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const cdp = await Cdp.attach(PORT)

  await hideScrollbars(cdp)

  for (const shot of SHOTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: shot.size.width,
      height: shot.size.height,
      deviceScaleFactor: 2,
      mobile: false
    })

    // Setting the hash re-routes in place rather than reloading, so SWR keeps
    // what it already has and only the new screen's reads have to land.
    await cdp.evaluate(`location.hash = ${JSON.stringify(shot.hash)}`)
    await cdp.evaluate('document.querySelector("main")?.scrollTo(0, 0)')
    await wait(300)
    await settle(cdp)

    if (shot.click) {
      const clicked = await cdp.evaluate(`(() => {
        const needle = ${JSON.stringify(shot.click)}.slice(5)
        const button = [...document.querySelectorAll('button, [role="button"]')].find((node) =>
          node.textContent?.includes(needle)
        )
        if (!button) return 'not found: ' + needle
        button.click()
        return 'ok'
      })()`)

      if (clicked !== 'ok') console.warn(`  (click: ${clicked})`)
      await wait(400)
      await settle(cdp)
    }

    if (shot.scrollTo) {
      // Jump instantly rather than smoothly: a smooth scroll would still be
      // moving when the screenshot is taken.
      const moved = await cdp.evaluate(`(() => {
        const spec = ${JSON.stringify(shot.scrollTo)}
        const offset = ${shot.offset ?? 0}
        const scroller = document.querySelector('main')
        if (!scroller) return 'no scroller'

        let target = null
        if (spec.startsWith('file:')) {
          target = document.getElementById('file-' + encodeURIComponent(spec.slice(5)))
        } else if (spec.startsWith('text:')) {
          // Markdown splits a sentence across inline code spans, so the phrase
          // rarely sits in a leaf. Take the *smallest* element that contains all
          // of it - that is the paragraph, not the page.
          const needle = spec.slice(5)
          const matches = [...document.querySelectorAll('*')].filter((node) =>
            node.textContent?.includes(needle)
          )
          target = matches.sort(
            (a, b) => a.textContent.length - b.textContent.length
          )[0]
        }
        if (!target) return 'not found: ' + spec

        const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        scroller.scrollTo({ top: scroller.scrollTop + top + offset, behavior: 'instant' })
        return 'ok'
      })()`)

      if (moved !== 'ok') console.warn(`  (scroll: ${moved})`)
      await wait(500)
    }

    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })

    const file = join(OUT_DIR, `${shot.name}.png`)
    await writeFile(file, Buffer.from(data, 'base64'))
    console.log(`${file}  ${shot.size.width}x${shot.size.height} @2x  - ${shot.note}`)
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
