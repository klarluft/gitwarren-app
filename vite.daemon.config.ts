import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Build for the headless daemon.
 *
 * The same shape as `vite.mcp.config.ts`, for the same reasons, and that is
 * worth stating rather than leaving to be inferred: CommonJS because it is
 * launched from inside the packaged app through `ELECTRON_RUN_AS_NODE`, where
 * `require` resolution is the well-trodden path to the unpacked
 * `better-sqlite3` binding under `app.asar.unpacked`; `noExternal: true`
 * because a Vite SSR build otherwise externalises bare imports and produces a
 * bundle that requires `drizzle-orm` at runtime - a devDependency, and so not
 * shipped inside the app. Only the native addon stays a real `require`.
 *
 * The two configs are not merged into one parameterised file. They will diverge
 * in M4, when the daemon is also built for the standalone tarball with a
 * different `better-sqlite3` resolution and a different Node target, and a
 * shared config with two modes would be harder to read than two configs that
 * happen to agree today.
 *
 * Unlike the MCP bundle, this one has no `@modelcontextprotocol/sdk` in it: the
 * daemon speaks GitWarren's own protocol, not MCP. Agents never talk to it.
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
    outDir: 'out/daemon',
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    minify: false,
    rollupOptions: {
      input: resolve('src/daemon/serve.ts'),
      external: ['better-sqlite3', /^node:/],
      output: {
        format: 'cjs',
        entryFileNames: 'serve.cjs',
        inlineDynamicImports: true
      }
    }
  }
})
