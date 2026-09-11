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
import { outcomeOf, type BridgeCarrier, type Carrier } from '@shared/rpc'
import type { GitWarrenBridge } from '@shared/api'

/**
 * The carrier, in the shape `window.gitwarren` promises.
 *
 * A tab has no `contextBridge` and could throw perfectly well - the socket
 * carrier and the screens that read it are the same world, so an `AppError`
 * crosses nothing and loses nothing. It hands back an outcome anyway, because
 * the *Electron* bridge has no choice (see `BridgeCarrier` in `shared/rpc.ts`)
 * and one shape means `lib/api.ts` has one way of asking rather than a branch
 * for which shell it happens to be running in.
 *
 * The round trip through `toSerialized` and back is the price, and it is a
 * plain object copy on a path that is already a network request.
 */
function asBridgeCarrier(carrier: Carrier): BridgeCarrier {
  return {
    request: (method, params, host) => outcomeOf(() => carrier.request(method, params, host))
  }
}

export function installBridge(): GitWarrenBridge {
  // The shell is handed the carrier, which the preload's never needed. Two of
  // the things a tab does for itself - attaching an image, opening a file in an
  // editor - are half a question for the host and half an action here, and the
  // host half is an ordinary method. See `shell.ts` on where that line falls.
  const carrier = createWebCarrier()
  const bridge: GitWarrenBridge = {
    carrier: asBridgeCarrier(carrier),
    // The shell keeps the throwing carrier: it is ordinary in-world code, and
    // `openInEditor` wants the path rather than an outcome to unwrap.
    shell: createWebShell(carrier)
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
