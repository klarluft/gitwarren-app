#!/usr/bin/env node
/**
 * `npx gitwarren` - the third way to get this, and the only one that does not
 * ship a Node.
 *
 * The tarball from spike S3 carries its own interpreter because the machines it
 * targets have none. Somebody typing `npx` has already proved they have one, so
 * this package carries the bundles and lets `better-sqlite3` be an ordinary
 * dependency - which is how a native addon is supposed to reach a user's
 * platform, and is the reason this package is a tenth of the tarball's size and
 * works on Windows without a fourth build target.
 *
 * ## What this file does, and why it is a file rather than a `bin` entry
 *
 * Two environment variables, and then the bundle. `GITWARREN_MIGRATIONS_DIR`
 * and `GITWARREN_WEB_ROOT` are how a build says where its non-JavaScript parts
 * went, and outside Electron there is no `resourcesPath` and no project root to
 * walk up to - so somebody has to name them. In the tarball it is a `sh`
 * preamble; here it is these six lines.
 *
 * They are set rather than defaulted, and `??=` rather than `=`, so that
 * someone debugging a build can still point either one somewhere else without
 * editing an installed package.
 *
 * `createRequire` because the bundle is CommonJS - see `vite.daemon.config.ts`
 * on why - and this file is ESM so that `import.meta.dirname` is available to
 * locate it. The two module systems meet here and nowhere else.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

process.env.GITWARREN_MIGRATIONS_DIR ??= join(import.meta.dirname, '..', 'drizzle')
process.env.GITWARREN_WEB_ROOT ??= join(import.meta.dirname, '..', 'web')

createRequire(import.meta.url)('../lib/gitwarren.cjs')
