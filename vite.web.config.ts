import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The renderer, built for a browser instead of for a window.
 *
 * Every line of the app is the same; what changes is the twenty lines in front
 * of it. `src/web/main.ts` installs a `window.gitwarren` built on a WebSocket
 * where the preload installs one built on Electron IPC, and then imports
 * exactly the same `renderer/src/main.tsx`. That is why this config exists as a
 * sibling of `electron.vite.config.ts`'s renderer section rather than as a mode
 * inside it: two roots, two entry points, one source tree.
 *
 * ## `base: './'`, and why it is safe here
 *
 * The Electron app serves this build under `/app/` and a `gitwarren serve`
 * serves it under `/`. Absolute asset URLs would have to pick one; relative
 * ones resolve against the document's own path and work under both. That is
 * only sound because routing is in the *hash* - `#/reviews/4/files` - so the
 * path of the document is always exactly the mount, however deep the user has
 * navigated. A history-API router would break this immediately, which is worth
 * knowing before anyone changes one.
 *
 * The trailing slash on the mount is load-bearing for the same reason, and the
 * server redirects `/app` to `/app/` rather than trusting anyone to type it.
 */
export default defineConfig({
  root: resolve('src/web'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/web/index.html')
    }
  }
})
