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
 * `wide` is 1200x800. The reading tabs cap their content at `max-w-5xl`
 * (1024px), so a wider frame buys them empty gutters rather than more app; 3:2
 * is also the shape a desktop window actually is, which keeps the hero honest.
 * The files tab does go wider than this on a wide window - see `reviewWidth` in
 * `App.tsx` - so a diff shot here is a narrower window, not the ceiling.
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
    // A GitWarren already running on the capture machine holds the link port,
    // and the page says so - true of this machine, not of the product. And the
    // database row would print the throwaway data directory the seed wrote,
    // and an unpackaged build reports its version as "(dev)".
    hideText: [
      { text: 'Another program is using port' },
      { text: '/gitwarren.db', upTo: 'Database' },
      { text: '(dev)', upTo: 'Version' }
    ],
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
    name: '12-side-by-side',
    // The Markdown file, because it carries the one rewritten line in the
    // demo: side by side is about the words that changed, not added code.
    hash: '#/reviews/2/files',
    size: WIDE,
    prefs: { 'diff-layout': 'split' },
    scrollTo: 'file:README.md',
    offset: -40,
    note: 'A diff side by side, with only the changed words marked on a rewritten line.'
  },
  {
    name: '13-markdown-preview',
    hash: '#/reviews/2/files',
    size: WIDE,
    prefs: { 'markdown-view': 'preview' },
    scrollTo: 'file:README.md',
    offset: -40,
    note: 'A changed Markdown file rendered, with its additions and removals marked.'
  },
  {
    name: '14-repository-files',
    hash: `#/repositories/1/files/${encodeURIComponent('src/renderer/src/lib/shortcuts.ts')}`,
    size: WIDE,
    note: "The repository's own Files tab: the checkout as it is on disk, highlighted."
  },
  {
    name: '15-light-theme',
    hash: '#/reviews/1/files',
    size: WIDE,
    theme: 'light',
    note: 'The hero view again, in the light theme.'
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

    // View preferences are read when a screen mounts (`lib/preferences.ts`),
    // so write them first and pass through the home screen to remount the
    // one being captured. The theme is the `.dark` class on <html>, which
    // everything - the highlighter included - follows (`lib/theme.ts`).
    if (shot.prefs || shot.theme) {
      await cdp.evaluate(`(() => {
        for (const [key, value] of Object.entries(${JSON.stringify(shot.prefs ?? {})})) {
          localStorage.setItem('gitwarren:' + key, value)
        }
        document.documentElement.classList.toggle('dark', ${JSON.stringify(shot.theme ?? 'dark')} === 'dark')
        location.hash = '#/'
      })()`)
      await wait(300)
    }

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

    for (const { text, upTo } of shot.hideText ?? []) {
      // The smallest element holding the text, widened either to the first
      // ancestor that also holds `upTo` (a label beside a value), or to the
      // outermost one that holds nothing else - the whole notice, border
      // included.
      const hidden = await cdp.evaluate(`(() => {
        const needle = ${JSON.stringify(text)}
        const upTo = ${JSON.stringify(upTo ?? null)}
        let node = [...document.querySelectorAll('*')]
          .filter((el) => el.textContent?.includes(needle))
          .sort((a, b) => a.textContent.length - b.textContent.length)[0]
        if (!node) return 'not found: ' + needle
        if (upTo) {
          while (node.parentElement && !node.textContent.includes(upTo)) node = node.parentElement
        } else {
          const own = node.textContent.trim()
          while (node.parentElement && node.parentElement.textContent.trim() === own) {
            node = node.parentElement
          }
        }
        node.style.display = 'none'
        return 'ok'
      })()`)
      if (hidden !== 'ok') console.warn(`  (hide: ${hidden})`)
      await wait(200)
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

    // Put the defaults back, so the next shot sees the app as installed.
    if (shot.prefs || shot.theme) {
      await cdp.evaluate(`(() => {
        for (const key of ${JSON.stringify(Object.keys(shot.prefs ?? {}))}) {
          localStorage.removeItem('gitwarren:' + key)
        }
        document.documentElement.classList.add('dark')
        location.hash = '#/'
      })()`)
      await wait(300)
    }
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride')
  cdp.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
