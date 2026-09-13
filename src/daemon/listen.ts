/**
 * `gitwarren serve --listen`: GitWarren with a browser tab for a shell.
 *
 * The other carrier in this directory answers a pipe somebody else opened. This
 * one binds a port, which makes it a completely different kind of process - it
 * is a candidate for *owning* the machine, and ownership is the thing
 * `core/daemon-runtime.ts` exists to arbitrate. A data directory has one owner;
 * the second process to want it stands aside.
 *
 * So this refuses to start next to a running GUI, and says why. That is not the
 * `--stdio` rule reversed for no reason: a stdio daemon binds nothing, answers
 * one pipe and dies with its parent, so it is not competing for anything - and
 * refusing *there* would break M4, where a Mac spawns a daemon on a PC that is
 * quite reasonably running its own GitWarren. Here the two would be fighting
 * over one port and one link, and the honest answer is that the app already
 * has them.
 *
 * ## What it serves
 *
 * The web build, at `/`, gated by the token in `core/web/token.ts`. At `/`
 * rather than under `/app/` because there is no Electron app here to hand a
 * `gitwarren://` link to, so there is no "Open in GitWarren" page worth
 * serving: an agent's `guiUrl` should simply *be* the review, which is the hop
 * M3 exists to remove. The app mounts the identical handler one level down for
 * the opposite reason - see `shared/web.ts`.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDatabase } from '../core/db/client.js'
import {
  clearDaemonRuntime,
  readLiveDaemonRuntime,
  writeDaemonRuntime,
  type DaemonRuntime
} from '../core/daemon-runtime.js'
import { getInstanceId } from '../core/instance.js'
import { describeMcpLaunch } from '../core/mcp-launcher.js'
import { getDatabasePath, getDataDirectory } from '../core/paths.js'
import { createWebHandler } from '../core/web/handler.js'
import { configureExposure, refreshExposure, tailnetGate } from '../core/web/exposure.js'
import { clearWebToken, getWebTokenPath, mintWebToken, publishWebToken } from '../core/web/token.js'
import { LINK_SERVER_HOST, LINK_SERVER_PORT } from '../shared/link-port.js'
import { TOKEN_PARAM, WEB_APP_MOUNT } from '../shared/web.js'
import type { AppInfo } from '../shared/api.js'

/** Stamped by `vite.daemon.config.ts`. Nothing reads a package.json out of a bundle. */
declare const __APP_VERSION__: string

/**
 * `typeof` rather than the identifier: `tsx src/cli/gitwarren.ts serve` runs
 * this file with no build in front of it, so the define does not exist and a
 * bare reference would be a crash on startup in the one mode used for
 * development.
 */
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'

/**
 * Where the web build is, in the three places this process can be run from.
 *
 * The env var is first so a tarball that puts the files somewhere else - or
 * someone debugging a build - can say so without a code change. Then the
 * sibling of this file, which is `out/web` next to `out/daemon/gitwarren.cjs`,
 * and finally the repository's own `out/`, which is what `tsx
 * src/cli/gitwarren.ts` has to fall back to.
 *
 * ## Why "has an index.html" is not the test
 *
 * Because `src/web` has one too - it is Vite's entry document, and it points at
 * `./main.ts`, which no browser can execute. Run under tsx, the sibling of this
 * file *is* that directory, so the obvious check picks the source tree, serves
 * a page that fetches TypeScript, and produces a blank screen with a MIME error
 * rather than an honest "no web build". A built document never mentions
 * `main.ts` - Vite emits hashed names - so the absence of that file is what
 * separates the two, and it is checked rather than assumed because the failure
 * it prevents is silent.
 */
function isWebBuild(directory: string): boolean {
  return existsSync(join(directory, 'index.html')) && !existsSync(join(directory, 'main.ts'))
}

/**
 * Exported because `service install` has to name this directory in a file
 * rather than find it later. See the header of `cli/install.ts`: the third
 * candidate below is relative to the working directory, and a login item has
 * no working directory worth the name.
 */
export function resolveWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.GITWARREN_WEB_ROOT,
    join(here, '..', 'web'),
    resolve(process.cwd(), 'out', 'web')
  ]

  for (const candidate of candidates) {
    if (candidate && isWebBuild(candidate)) return resolve(candidate)
  }
  return null
}

/**
 * What this install can tell a browser about itself.
 *
 * Thinner than the app's: there is no `app.getVersion()`, no updater and no
 * `isPackaged`. The MCP launcher path is the one field worth getting exactly
 * right, because the Agent Access page prints it as a command to paste, and a
 * daemon that named a different path from the app's would hand out an
 * instruction that works on one of them - hence `core/mcp-launcher.ts`.
 */
function describeInstall(linkPort: number | null): AppInfo {
  // `describeMcpLaunch` rather than built here, because since M4.4 the same
  // answer goes out over `app.mcp` to a GUI on another machine looking at this
  // one's Agent Access page. The daemon does not write the launcher - M3.3's
  // `gitwarren service install` does - so it reports the path and lets
  // `available` say whether anything is there yet.
  const mcp = describeMcpLaunch()

  return {
    version: VERSION,
    instanceId: getInstanceId(),
    platform: process.platform,
    packaged: true,
    dataDirectory: getDataDirectory(),
    databasePath: getDatabasePath(),
    linkPort,
    mcp
  }
}

/**
 * How to reach the GitWarren that already owns this data directory, as the tail
 * of the sentence that refuses to start a second one.
 *
 * The refusal used to end at "use the one that is running", which names no way
 * to actually do it. The token is minted per launch and published to a 0600
 * file, so somebody who has closed the terminal that printed it - or who never
 * had one, because the owner is a login item or the app - has nothing to type.
 * Reading that file is precisely what `gitwarren open` does, and doing it here
 * costs one `readFileSync` on a path that is already this process's own.
 *
 * The two failures answer as themselves rather than as a URL that would not
 * open. `linkPort: null` is an owner that is up but could not bind, which
 * `core/daemon-runtime.ts` records deliberately; an unreadable token file is an
 * owner older than its web view, or one that could not write it. Neither is
 * improved by guessing.
 *
 * The mount is the *owner's*, which is why this cannot simply repeat the URL
 * the success path below prints. An app serves the web build under `/app/` and
 * keeps `/` for the "Open in GitWarren" page; a `serve --listen` has no such
 * page to protect and serves it at `/`. `shared/web.ts` holds that rule and
 * `runtime.owner` says which of the two is up.
 */
function whereTheOwnerIs(owner: DaemonRuntime): string {
  if (owner.linkPort === null) {
    return ', which could not bind its loopback port, so it has no page to open.'
  }

  let token: string
  try {
    token = readFileSync(getWebTokenPath(), 'utf8').trim()
  } catch {
    return (
      `. Its token could not be read from ${getWebTokenPath()}, so there is no URL to ` +
      `print here; restarting that process mints a new one.`
    )
  }

  const mount = owner.owner === 'gui' ? `${WEB_APP_MOUNT}/` : '/'
  const url =
    `http://${LINK_SERVER_HOST}:${owner.linkPort}${mount}` +
    `?${TOKEN_PARAM}=${encodeURIComponent(token)}`
  return `:\n\n    ${url}\n`
}

/**
 * What the CLI wants done once the server is up, and not before.
 *
 * Both are things a person - never a spawning program - asked for by typing
 * `gitwarren serve`, and both belong after the bind rather than before it: a
 * refusal to start should write nothing and open nothing.
 */
export interface ListenHooks {
  /** Called once, with the URL that was just printed. */
  onListening?: (url: string) => void
}

/**
 * Bind, publish, and print the one URL that works.
 *
 * Returns false when it could not start, so the CLI entry can exit with something
 * a script can read. Every refusal prints a sentence naming what to do about
 * it: this is a command someone typed, and an exit code on its own is not an
 * answer.
 */
export function runListen(hooks: ListenHooks = {}): boolean {
  const owner = readLiveDaemonRuntime()
  if (owner) {
    // The background service is the likeliest "another gitwarren serve" on a
    // machine where someone has just typed this, and it is the one the person
    // cannot see in a terminal - so it gets named, and so does the way to stop
    // it.
    const who =
      owner.owner === 'gui'
        ? 'the desktop app'
        : 'another `gitwarren serve`, in a terminal or as the background service ' +
          '(which `gitwarren service uninstall` stops)'
    console.error(
      `[gitwarren] GitWarren is already running on this machine (pid ${owner.pid}), as ${who}. ` +
        `Only one can serve a data directory at a time. Quit that first, or use the one that is running` +
        whereTheOwnerIs(owner)
    )
    process.exitCode = 1
    return false
  }

  const webRoot = resolveWebRoot()
  if (!webRoot) {
    console.error(
      '[gitwarren] no web build found. Run `npm run build:web`, or set ' +
        'GITWARREN_WEB_ROOT to the directory holding its index.html.'
    )
    process.exitCode = 1
    return false
  }

  // Before the first request, so a browser's opening burst does not race the
  // migrations - the same reason `daemon.ts` does it before the first frame.
  getDatabase()

  const token = mintWebToken()
  publishWebToken(token)

  let linkPort: number | null = null
  configureExposure({ mount: '/', port: LINK_SERVER_PORT })
  void refreshExposure()

  const handler = createWebHandler({
    mount: '/',
    staticRoot: webRoot,
    token,
    appInfo: () => describeInstall(linkPort),
    tailnet: tailnetGate
  })

  const server = createServer((request, response) => {
    // Everything is the web handler's here; a path it does not claim is a 404
    // rather than a fallback to some other page, because there is no other page.
    if (!handler.request(request, response)) response.writeHead(404).end()
  })

  server.on('upgrade', (request, socket, head) => {
    if (!handler.upgrade(request, socket, head)) socket.destroy()
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[gitwarren] port ${LINK_SERVER_PORT} is already in use. That port is the one ` +
          `every GitWarren link names, so serving on a different one would mean serving where ` +
          `nobody is looking. Free it and start again.`
      )
    } else {
      console.error('[gitwarren] the server failed', error)
    }
    shutdownListen()
    process.exitCode = 1
  })

  server.listen(LINK_SERVER_PORT, LINK_SERVER_HOST, () => {
    linkPort = LINK_SERVER_PORT
    writeDaemonRuntime({
      instanceId: getInstanceId(),
      pid: process.pid,
      linkPort,
      owner: 'daemon'
    })

    // stderr, like every other diagnostic here: stdout belongs to the protocol
    // in the other carrier and there is no reason for the two to disagree about
    // which stream a human message goes on.
    //
    // The three sentences after the URL are the whole of what a person who has
    // just typed `gitwarren serve` for the first time needs: why the URL looks
    // like that, how to stop this, and that there is a way not to have to run
    // it by hand. Each was a question in somebody's first ten minutes.
    const url = `http://${LINK_SERVER_HOST}:${LINK_SERVER_PORT}/?${TOKEN_PARAM}=${token}`
    console.error(
      `[gitwarren] GitWarren is running at\n\n` +
        `    ${url}\n\n` +
        `Open that URL, or run \`gitwarren open\` in another terminal. The token in it is ` +
        `minted for this launch and becomes a cookie the first time the page loads.\n` +
        `Press Ctrl-C to stop. To keep GitWarren running in the background instead, ` +
        `from now and at every login, use \`gitwarren service install\`.`
    )
    hooks.onListening?.(url)
  })

  closeOnExit = () => {
    handler.close()
    server.close()
  }

  return true
}

let closeOnExit: (() => void) | null = null

/** Release everything this mode claimed. Safe to call when it never started. */
export function shutdownListen(): void {
  closeOnExit?.()
  closeOnExit = null
  clearWebToken()
  clearDaemonRuntime()
  closeDatabase()
}
