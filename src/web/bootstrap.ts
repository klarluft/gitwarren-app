/**
 * What the preload script is, for a tab.
 *
 * `window.gitwarren` is the whole contract between the renderer and whatever is
 * hosting it - a carrier and a shell, and nothing else (`shared/api.ts`). The
 * preload builds one over Electron IPC; this builds one over a WebSocket, and
 * every screen above `lib/api.ts` is unable to tell which it got. That was the
 * promise M1 made when it drew the line; this file is where it is collected.
 *
 * The bridge is installed *synchronously*, before the renderer module is
 * evaluated, because `lib/api.ts` reads `window.gitwarren` at module scope and
 * throws if it is missing. The socket underneath it is still connecting at that
 * moment, which is fine and deliberate - see `carrier.ts` on queueing.
 */
import { createWebCarrier } from './carrier'
import { createWebShell } from './shell'
import { isLoopbackFragment, routeForLoopbackFragment } from './loopback-fragment'
import { hrefFor } from '@shared/routes'
import type { GitWarrenBridge } from '@shared/api'

export function installBridge(): GitWarrenBridge {
  const bridge: GitWarrenBridge = {
    carrier: createWebCarrier(),
    shell: createWebShell()
  }

  window.gitwarren = bridge
  return bridge
}

/**
 * Put the initial location into the app's own grammar, before the router reads
 * it.
 *
 * Only a loopback link needs this, which is a link's first load and nothing
 * else - see `loopback-fragment.ts` for the rules, which are the ones
 * `main/deep-link.ts` applies in the other shell.
 *
 * `replace` rather than an assignment: the URL the agent handed out should not
 * become a back-button target, and there is nothing behind it to go back to on
 * a cold load anyway. `hrefFor` returns a string that already begins with `#`,
 * so it is passed through untouched.
 */
export async function normaliseInitialLocation(bridge: GitWarrenBridge): Promise<void> {
  if (!isLoopbackFragment(window.location.hash)) return

  // The one thing a browser tab cannot know without asking: which install is
  // serving it. One request, and only ever on a link's first load.
  const { instanceId } = await bridge.shell.system.appInfo()

  const route = routeForLoopbackFragment(window.location.hash, instanceId)
  if (route) window.location.replace(hrefFor(route))
}
