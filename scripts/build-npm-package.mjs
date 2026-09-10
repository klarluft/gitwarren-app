/**
 * `npx gitwarren`, assembled into `out/npm`.
 *
 *   npm run build:mcp && npm run build:daemon && npm run build:web
 *   node scripts/build-npm-package.mjs
 *   npm pack ./out/npm      # or `npm publish ./out/npm`
 *
 * The `./` is required and is not style. npm reads a bare `out/npm` as the
 * GitHub shorthand `<owner>/<repo>` and goes looking for a repository of that
 * name, failing with "An unknown git error occurred" - a message with nothing
 * in it about the directory that is sitting right there.
 *
 * The third distribution, and the only one that does not ship an interpreter.
 * The tarball from spike S3 carries its own Node because the hosts it targets
 * have none; someone typing `npx` has proved they have one, so this package
 * declares `better-sqlite3` as an ordinary dependency and lets npm deliver the
 * right prebuild for whatever platform it is being installed on. That is what
 * makes it the Windows answer without a fourth build target - see the header of
 * `build-daemon-tarball.mjs`.
 *
 * ## Why the root package.json is not published
 *
 * `package.json` at the repository root is `"private": true` and describes an
 * Electron application: `main` points into `out/main`, the dependency list is
 * every build tool this project has, and `electron-builder install-app-deps`
 * runs on `postinstall`. Publishing it - even with `files` narrowed - would
 * hand every `npx gitwarren` user an Electron download and a native rebuild
 * against Electron's headers, for a command line that uses neither.
 *
 * So the published manifest is its own file, `packaging/npm/package.template.json`,
 * with one substitution. The version comes from the root manifest because that
 * is the string `vite.daemon.config.ts` stamps into the bundle, and a package
 * whose `--version` disagreed with its own metadata would be a genuinely
 * confusing thing to debug.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const packaging = join(root, 'packaging', 'npm')
const out = join(root, 'out', 'npm')

/**
 * What has to have been built, and which script builds it.
 *
 * Checked before anything is copied so that a missing bundle is a sentence
 * naming the command to run, rather than a package that publishes fine and
 * fails on the user's first invocation with `Cannot find module`.
 */
const inputs = [
  { from: join(root, 'out', 'daemon', 'gitwarren.cjs'), to: 'lib/gitwarren.cjs', script: 'build:daemon' },
  { from: join(root, 'out', 'mcp', 'server.cjs'), to: 'lib/server.cjs', script: 'build:mcp' },
  { from: join(root, 'out', 'web'), to: 'web', script: 'build:web' },
  { from: join(root, 'drizzle'), to: 'drizzle', script: 'db:generate' }
]

for (const input of inputs) {
  if (!existsSync(input.from)) {
    console.error(`${input.from} is missing - run \`npm run ${input.script}\` first`)
    process.exit(2)
  }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'lib'), { recursive: true })

for (const input of inputs) cpSync(input.from, join(out, input.to), { recursive: true })
cpSync(join(packaging, 'bin'), join(out, 'bin'), { recursive: true })

const manifest = readFileSync(join(packaging, 'package.template.json'), 'utf8')
writeFileSync(join(out, 'package.json'), manifest.replaceAll('__VERSION__', version), 'utf8')

// The licence travels with the code it covers - GPL-3.0-or-later says so, and
// npm shows the file on the package page. The README is the CLI's own rather
// than the app's: `packaging/npm/README.md` is written for someone who arrived
// by typing `npx gitwarren` and has no menu bar icon to look at.
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'))
cpSync(join(packaging, 'README.md'), join(out, 'README.md'))

console.log(`${out} (gitwarren@${version})`)
