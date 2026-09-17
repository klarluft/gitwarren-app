/**
 * `npm run visual` - photograph the app, from a fixture, without a server.
 *
 * Four things happen here in order, and the order is the design:
 *
 *  1. A scratch data directory is named *before the core is imported*, because
 *     `core/paths.ts` reads it at module scope. Every dynamic `import()` below
 *     is that constraint showing through, not a style choice.
 *  2. `visual/fixture.ts` builds a real git repository and a real review in a
 *     real SQLite database.
 *  3. Vite serves `visual/index.html`, which is the app's own renderer with a
 *     different twenty lines in front of it.
 *  4. Chromium opens it with `__visualRequest` already installed, and every
 *     question the screen asks is answered by the real dispatcher in *this*
 *     process. No HTTP, no WebSocket, no port to collide with the GitWarren the
 *     developer has running, no token to exchange.
 *
 * What comes out is `visual/shots/*.png`, which is gitignored: a screenshot is
 * an artefact of a run, not a fact about the repository. This is a *looking*
 * tool and deliberately not a visual-regression suite - nothing here compares
 * against a baseline, because a committed baseline of a UI under active design
 * is a file somebody has to re-bless every time they move a border, and it
 * teaches people to re-bless without looking.
 *
 * Usage:
 *   npm run visual                  every shot, light
 *   npm run visual -- --dark        every shot, dark
 *   npm run visual -- --only browse-search
 *   npm run visual -- --width 1100
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createServer, type ViteDevServer } from 'vite'
import type { AppInfo } from '../src/shared/api.js'

/** Where the shots land. Gitignored - see the note at the top. */
const SHOTS = resolve('visual/shots')

/**
 * Wide enough for the two-column layouts, which is the whole point: below
 * Tailwind's `lg` (64rem) `useNarrow` swaps the sidebar for a screen of its
 * own, and a harness that photographed that by accident would be photographing
 * the layout nobody was asking about. `--width` is there for when the narrow
 * one *is* the question.
 */
const DEFAULT_WIDTH = 1440
const HEIGHT = 900

interface Shot {
  name: string
  /** What the app's own router calls this place. */
  hash: (ids: { reviewId: number; repositoryId: number }) => string
  /** Something to wait for beyond the network going quiet. */
  settle?: (page: Page) => Promise<unknown>
}

/**
 * The screens worth a picture, in the order somebody reviewing would meet them.
 *
 * A list rather than a test per screen: these are not assertions, they are
 * viewpoints, and the cost of adding one should be one line.
 *
 * It describes *this branch*, and is expected to grow in the same commit as the
 * screen it photographs - a shot naming a control that does not exist yet fails
 * the run, which is the right way round. Nothing here is a baseline, so a shot
 * that is deleted with its feature leaves nothing behind to re-bless.
 */
const SHOTS_TO_TAKE: Shot[] = [
  {
    name: 'review-conversation',
    hash: ({ reviewId }) => `#/reviews/${reviewId}/conversation`
  },
  {
    name: 'files-changed',
    hash: ({ reviewId }) => `#/reviews/${reviewId}/files`
  },
  {
    name: 'browse-tree',
    hash: ({ reviewId }) => `#/reviews/${reviewId}/browse`
  },
  {
    name: 'browse-filtered',
    hash: ({ reviewId }) => `#/reviews/${reviewId}/browse`,
    settle: async (page) => {
      await page.getByLabel('Filter files in this repository').fill('index')
    }
  },
  {
    name: 'browse-file-open',
    hash: ({ reviewId }) =>
      `#/reviews/${reviewId}/browse/${encodeURIComponent('src/core/git-search.ts')}`
  }
]

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function main(): Promise<void> {
  const dark = process.argv.includes('--dark')
  const only = arg('only')
  const width = Number(arg('width') ?? DEFAULT_WIDTH)

  // Before any core import. `core/paths.ts` reads this at module scope, and a
  // harness that wrote into the developer's real database would be a harness
  // nobody could be talked into running twice.
  const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-visual-data-'))
  process.env.GITWARREN_DATA_DIR = dataDir

  const { buildFixture } = await import('./fixture.js')
  const { dispatch } = await import('../src/core/rpc/dispatcher.js')
  const { outcomeOf } = await import('../src/shared/rpc.js')
  const { closeDatabase } = await import('../src/core/db/client.js')
  const { WEB_PATHS } = await import('../src/shared/web.js')
  const { APP_VERSION } = await import('../src/core/version.js')
  const { getInstanceId } = await import('../src/core/instance.js')
  const { describeMcpLaunch } = await import('../src/core/mcp-launcher.js')
  const { getDataDirectory, getDatabasePath } = await import('../src/core/paths.js')

  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  const fixture = await buildFixture()

  try {
    server = await createServer({
      configFile: resolve('vite.visual.config.ts'),
      /**
       * The one thing the shell asks for over HTTP rather than through the
       * carrier.
       *
       * `createWebShell` fetches `app-info` directly, because in a tab it is
       * the question "which install is serving this page" and the carrier is
       * not the thing that knows. The daemon answers it; a dev server does not,
       * so every run logged a 404 and the shell threw behind it.
       *
       * It has to be a *plugin* rather than a `server.middlewares.use` after
       * `createServer`: Vite installs its own middlewares - including the 404
       * that was answering this - while the server is being created, and
       * anything added afterwards is behind them. A `configureServer` hook runs
       * before they are installed, which is the documented way in.
       *
       * Answered with the real values rather than a plausible-looking stub. The
       * version, instance id and paths come from the same core functions the
       * daemon's own `describeInstall` calls, and the object is typed
       * `AppInfo`, so a field added to that interface fails this build instead
       * of quietly going missing from the harness.
       */
      plugins: [
        {
          name: 'gitwarren-visual-app-info',
          configureServer(dev) {
            dev.middlewares.use(WEB_PATHS.appInfo, (_request, response) => {
              const info: AppInfo = {
                version: APP_VERSION,
                instanceId: getInstanceId(),
                platform: process.platform,
                // False, and honestly: this is a dev server, and a screen that
                // says so tells the truth about where the picture was taken.
                packaged: false,
                dataDirectory: getDataDirectory(),
                databasePath: getDatabasePath(),
                linkPort: null,
                mcp: describeMcpLaunch()
              }
              response.setHeader('Content-Type', 'application/json')
              response.end(JSON.stringify(info))
            })
          }
        }
      ]
    })

    await server.listen()
    const port = server.httpServer?.address()
    if (port === null || port === undefined || typeof port === 'string') {
      throw new Error('The dev server did not report a port.')
    }
    const origin = `http://127.0.0.1:${port.port}`

    browser = await chromium.launch().catch((error: unknown) => {
      // `playwright-core` is the dependency rather than `playwright`, so that
      // installing this project never downloads 114 MB of browser on a machine
      // that will never take a screenshot - CI included. The price is that the
      // browser is fetched by hand once, and that a `playwright-core` upgrade
      // can move the revision it expects out from under an existing cache. Both
      // are the same one-line fix, so it is worth saying rather than leaving
      // Playwright's own "just installed or updated" banner to be puzzled over.
      throw new Error(
        `${String(error)}\n\nRun: npx playwright-core install chromium-headless-shell`
      )
    })
    const context = await browser.newContext({
      viewport: { width, height: HEIGHT },
      colorScheme: dark ? 'dark' : 'light',
      // A fixed ratio, so a shot taken on a laptop with a HiDPI screen is the
      // same file as one taken in CI.
      deviceScaleFactor: 2
    })

    const page = await context.newPage()

    // The carrier's other end. `dispatch` has no `host` parameter - routing to
    // another machine happens a layer above it - and the fixture is local, so a
    // host arriving here is a harness bug worth hearing about rather than
    // ignoring.
    await page.exposeFunction(
      '__visualRequest',
      (method: string, params: unknown, host: string | null) => {
        if (host !== null) throw new Error(`The harness cannot reach host ${host}.`)
        return outcomeOf(() =>
          dispatch(method as Parameters<typeof dispatch>[0], params as never)
        )
      }
    )

    // Anything the page logs is a symptom worth seeing: a failed request, a
    // React warning, a missing asset. Printed rather than collected, so a run
    // that produces an ugly screenshot says why on the way past.
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.warn(`  [page ${message.type()}] ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => console.warn(`  [page error] ${error.message}`))
    // The console says "Failed to load resource" without saying which, which is
    // the one detail needed to fix it. This says which.
    page.on('response', (response) => {
      if (response.status() >= 400) {
        console.warn(`  [http ${response.status()}] ${response.url()}`)
      }
    })

    mkdirSync(SHOTS, { recursive: true })
    const wanted = only === undefined ? SHOTS_TO_TAKE : SHOTS_TO_TAKE.filter((s) => s.name === only)
    if (wanted.length === 0) throw new Error(`No shot is called "${only}".`)

    for (const shot of wanted) {
      const url = `${origin}/${shot.hash(fixture)}`
      // `load` rather than `networkidle`: every answer this app needs comes
      // through the exposed function rather than over the network, so the
      // network is idle long before the screen is ready. What settles it is the
      // work below and the app's own paint.
      await page.goto(url, { waitUntil: 'load' })
      // The app has painted something into its root. A selector rather than a
      // `waitForFunction`, so the wait is expressed in Playwright's own terms
      // rather than as browser code typechecked in a Node project.
      await page.waitForSelector('#root > *', { timeout: 15_000 })
      if (shot.settle) await shot.settle(page)
      // One frame for the last state change to paint. Cheaper and steadier than
      // guessing at a selector for whatever the settle step just did.
      await page.waitForTimeout(250)

      const file = join(SHOTS, `${shot.name}${dark ? '-dark' : ''}.png`)
      await page.screenshot({ path: file, fullPage: false })
      console.log(`  ${shot.name} -> ${file}`)
    }

    console.log(`\n${wanted.length} shot${wanted.length === 1 ? '' : 's'} in ${SHOTS}`)
  } finally {
    await browser?.close()
    await server?.close()
    closeDatabase()
    fixture.cleanup()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

await main()
