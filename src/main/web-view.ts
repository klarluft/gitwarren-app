/**
 * The web view, as the Electron app serves it.
 *
 * All of the work is in `core/web/handler.ts`; this file supplies the three
 * things only a packaged app knows - where the build ended up, what this
 * install is, and when to let go - and mounts the result under `/app/` on the
 * link server's port.
 *
 * ## Why the app serves it at all
 *
 * Because it owns the port. A `gitwarren serve` stands aside while the app is
 * running (`daemon/listen.ts`), so if the app did not serve the web view, the
 * browser shell would be reachable only when GitWarren was quit - which is the
 * opposite of the arrangement M2 built, where the app is the thing that is
 * always on. One owner, both shells.
 *
 * ## Where the files are
 *
 * `out/web` inside the app bundle, which in a packaged build is inside
 * `app.asar`. Reading from an asar is ordinary `fs` - Electron patches it - so
 * the static server needs to know nothing about it. What it does mean is that
 * the archive has to *contain* `out/web`, which is `electron-builder.yml`'s
 * `files` list, and that a `electron-vite dev` session has nothing there until
 * `npm run build:web` has been run once. That case is logged rather than
 * treated as a failure: the window works, and the browser shell is a second
 * distribution, not a dependency of the first.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { createWebHandler, type WebHandler } from '../core/web/handler.js'
import { clearWebToken, mintWebToken, publishWebToken } from '../core/web/token.js'
import { LINK_SERVER_HOST, LINK_SERVER_PORT } from '../shared/link-port.js'
import { TOKEN_PARAM, WEB_APP_MOUNT } from '../shared/web.js'
import { describeInstall } from './app-info.js'

let handler: WebHandler | null = null

/** The web build inside this install. */
function webRoot(): string {
  return join(app.getAppPath(), 'out', 'web')
}

/**
 * The URL that opens the web view in a browser, token and all.
 *
 * Null when there is no web build to open. Read by the Agent Access page in
 * M3.4; for now it is what the console line below prints, which is how the
 * milestone is verified.
 */
let entryUrl: string | null = null

export function getWebViewUrl(): string | null {
  return entryUrl
}

/**
 * Mint a token and build the handler, or return null when there is nothing to
 * serve. Called by `startLinkServer`, which owns the actual socket.
 */
export function startWebHandler(): WebHandler | null {
  if (handler) return handler

  const staticRoot = webRoot()
  if (!existsSync(join(staticRoot, 'index.html'))) {
    console.log(
      `[web] no web build at ${staticRoot}, so ${WEB_APP_MOUNT} is not served. ` +
        `Run \`npm run build:web\` to have it in a dev session.`
    )
    return null
  }

  const token = mintWebToken()
  publishWebToken(token)

  entryUrl =
    `http://${LINK_SERVER_HOST}:${LINK_SERVER_PORT}${WEB_APP_MOUNT}/` +
    `?${TOKEN_PARAM}=${token}`

  handler = createWebHandler({
    mount: `${WEB_APP_MOUNT}/`,
    staticRoot,
    token,
    appInfo: describeInstall
  })

  console.log(`[web] the web view is at ${entryUrl}`)
  return handler
}

/**
 * Drop the token on the way out.
 *
 * The token is per launch, so a file left behind would name a secret nothing
 * will ever accept again - harmless, and exactly the kind of harmless leftover
 * that makes someone debug the wrong thing a month later.
 */
export function stopWebHandler(): void {
  handler?.close()
  handler = null
  entryUrl = null
  clearWebToken()
}
