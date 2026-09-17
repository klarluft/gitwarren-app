/**
 * The harness page's entry point - `src/web/main.ts` with one word changed.
 *
 * The order is the whole file, for exactly the reason the web shell's is:
 * `renderer/src/lib/api.ts` reads `window.gitwarren` while its module is being
 * evaluated, so the bridge has to exist before that module is *imported*. A
 * dynamic import is how that is said in a way a bundler cannot reorder.
 *
 * There is no `normaliseInitialLocation` here. That resolves a loopback link on
 * its first load, and the harness navigates by writing the hash it wants.
 */
import { installBridge } from '@web/bootstrap'
import { createHarnessCarrier } from './carrier'

installBridge(createHarnessCarrier())

await import('@/main')
