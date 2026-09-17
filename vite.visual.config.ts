import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The renderer, built for a camera.
 *
 * A sibling of `vite.web.config.ts` and deliberately its near-copy: same
 * plugins, same aliases, same source tree, a different twenty lines in front of
 * it. The web config exists because a tab hosts the renderer over a WebSocket;
 * this one exists because a screenshot hosts it over a function Playwright
 * exposed. Two roots, two entry points, one app.
 *
 * `@web` is the one alias the other config does not need, because the other
 * config's root *is* `src/web`. Here the harness reaches into it to reuse
 * `installBridge` and `createWebShell` rather than assembling a second bridge
 * of its own - see `visual/carrier.ts` on why that matters.
 *
 * No `base: './'` and no `build` section: this config is only ever served by a
 * dev server on loopback, from `visual/capture.ts`, and never produces a
 * `dist`. A harness that shipped would be a harness that could rot unnoticed.
 */
export default defineConfig({
  root: resolve('visual'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      '@web': resolve('src/web')
    }
  },
  server: {
    // Assigned by the OS, and handed back through Vite's own API. The app's own
    // port is a fixed constant that a developer's running GitWarren is probably
    // already holding (`shared/link-port.ts`); a harness that picked a number
    // would collide with something eventually, and on a machine it did not own.
    port: 0,
    strictPort: false
  }
})
