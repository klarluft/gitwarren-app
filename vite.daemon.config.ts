import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { WS_PURE_JS } from './vite.ws-define.js'

/**
 * The app's version, inlined.
 *
 * The daemon tells a browser what it is running, and `app.getVersion()` - which
 * is where the Electron process gets the same string - does not exist here.
 * Reading a package.json at runtime is not an option either: there is not one
 * next to a single-file bundle inside a tarball. So the build stamps it, which
 * is the only moment the two are guaranteed to agree.
 */
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/**
 * Build for the headless daemon - which since M3.3 is the whole `gitwarren`
 * CLI, entered at `src/cli/gitwarren.ts` and emitted as `gitwarren.cjs`.
 *
 * One bundle rather than two. `serve`, `open` and `service install` share the
 * core, the database and `core/paths.ts`, and a second entry point would put a
 * second copy of all of it in a tarball to save nothing. The directory is still
 * `out/daemon` because that is what a machine with no screen gets, and because
 * `daemon/listen.ts` finds the web build as its sibling.
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
  define: {
    ...WS_PURE_JS,
    __APP_VERSION__: JSON.stringify(version)
  },
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
      input: resolve('src/cli/gitwarren.ts'),
      external: ['better-sqlite3', /^node:/],
      output: {
        format: 'cjs',
        entryFileNames: 'gitwarren.cjs',
        inlineDynamicImports: true
      }
    }
  }
})
