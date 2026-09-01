import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Build for the MCP stdio server.
 *
 * CommonJS on purpose: it is launched from inside the packaged app via
 * ELECTRON_RUN_AS_NODE, and `require` resolution is the well-trodden path for
 * reaching the unpacked better-sqlite3 native binding through app.asar.unpacked.
 *
 * Everything else is bundled in. A Vite SSR build externalises bare imports by
 * default, which produced a server that required `@modelcontextprotocol/sdk`
 * and `drizzle-orm` at runtime - packages that are devDependencies and so are
 * not shipped inside the app. `noExternal: true` inlines them instead, leaving
 * only the native addon to resolve from disk.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared')
    }
  },
  ssr: {
    noExternal: true,
    // A native .node addon cannot be inlined; it stays a real require().
    external: ['better-sqlite3']
  },
  build: {
    outDir: 'out/mcp',
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    minify: false,
    rollupOptions: {
      input: resolve('src/mcp/server.ts'),
      external: ['better-sqlite3', /^node:/],
      output: {
        format: 'cjs',
        entryFileNames: 'server.cjs',
        inlineDynamicImports: true
      }
    }
  }
})
