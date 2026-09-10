import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { WS_PURE_JS } from './vite.ws-define.js'
import { version } from './package.json'

export default defineConfig({
  main: {
    // `__APP_VERSION__` is what `core/version.ts` reads, and from M4 the main
    // process needs it too: `app.instance` reports this install's version to a
    // GUI on another machine, and the answer has to be the same string the
    // daemon build has stamped in since M3.3.
    define: { ...WS_PURE_JS, __APP_VERSION__: JSON.stringify(version) },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': resolve('src/core'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
