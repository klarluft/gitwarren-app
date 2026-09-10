/**
 * The web build's entry point: install the bridge, then hand over to the
 * renderer that has always assumed one was there.
 *
 * The order is the entire content of this file, and it is not decorative.
 * `renderer/src/lib/api.ts` reads `window.gitwarren` while its module is being
 * evaluated - not in an effect, not on first render - so the bridge has to
 * exist before that module is *imported*, which a top-level `import` of the
 * renderer would not guarantee across a bundler's hoisting. A dynamic import
 * says it in a way that cannot be reordered: this line, then that one.
 *
 * The `await` before it is for a link's first load only. When the hash carries
 * a loopback fragment (`#h=<instance>/…`) it has to be resolved against this
 * install before the router reads it, or the app paints the home screen and
 * jumps - see `bootstrap.ts`.
 */
import { installBridge, normaliseInitialLocation } from './bootstrap'

const bridge = installBridge()

await normaliseInitialLocation(bridge)
await import('@/main')
