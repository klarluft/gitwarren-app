/**
 * The self-contained GitWarren, as a release asset.
 *
 * Promoted from `scripts/spikes/s3-daemon-tarball.mjs`, which proved the idea
 * on 10 September 2026: a Node binary, the bundles, the one matching
 * `better_sqlite3.node` and the migrations, in a tarball that runs on a box
 * with nothing installed. See spike S3 in docs/across-hosts.md.
 *
 * The spike predated the daemon and carried only the MCP server. This carries
 * three things, because a host has three jobs to be capable of: answering a
 * GitWarren on another machine (`gitwarren serve --stdio`, over a pipe), being
 * reached by the agent working next to the code (`gitwarren-mcp`, over stdio),
 * and - since M3.3 - being *used*, which means `gitwarren serve` and a browser,
 * and therefore the web build.
 *
 * Nothing is compiled. better-sqlite3 ships prebuilds for every target here, so
 * a tarball for any of them can be built from any machine that can run
 * `npm ci` - which is what lets one ubuntu runner produce all four.
 *
 *   npm run build:mcp && npm run build:daemon && npm run build:web
 *   node scripts/build-daemon-tarball.mjs linux-x64
 *   node scripts/build-daemon-tarball.mjs darwin-arm64
 *
 * Prove one in a container with no Node (Docker calls x64 "amd64"):
 *
 *   printf '{"id":1,"method":"repositories.list"}\n' | docker run --rm -i \
 *     --platform linux/arm64 -v "$PWD/out/daemon-tarball:/t:ro" ubuntu:24.04 \
 *     sh -c 'tar xzf /t/gitwarren-daemon-*-linux-arm64.tar.gz -C /opt &&
 *            HOME=/root /opt/gitwarren-daemon/bin/gitwarren serve --stdio'
 *
 * ## Why macOS is in the list and Windows is not
 *
 * macOS because M3's verify sentence starts "on a Mac with no GitWarren.app,
 * `brew install` the formula" - a Homebrew formula pours a tarball, and it
 * cannot pour one that does not exist. The two macOS targets are also what
 * makes `gitwarren` a real answer for someone who does not want a menu-bar app
 * on a machine they already use GitWarren-shaped things on.
 *
 * Windows is left out on purpose rather than forgotten. A `.tar.gz` is not how
 * anything gets installed there, Node ships a `.zip` for it so this script's
 * one extraction step would need a second, and the two audiences that would
 * want it are already served: a desktop user installs the app, and someone who
 * wants the CLI has `npx gitwarren`, which is Windows' own package manager for
 * exactly this. `service install` still supports Windows for the npm case.
 */
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

const target = process.argv[2]
if (!TARGETS.includes(target)) {
  console.error(`usage: node scripts/build-daemon-tarball.mjs ${TARGETS.join('|')}`)
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/**
 * The Node version to embed.
 *
 * Read from `.nvmrc` so the tarball and CI cannot drift apart: a daemon built
 * against a different Node major from the one the bundles were built for is
 * exactly the kind of mismatch that shows up as a native-addon error on
 * somebody else's machine and nowhere else.
 */
const nodeVersion = `v${readFileSync(join(root, '.nvmrc'), 'utf8').trim()}`

const bundles = [
  { from: join(root, 'out', 'daemon', 'gitwarren.cjs'), to: 'gitwarren.cjs', script: 'build:daemon' },
  { from: join(root, 'out', 'mcp', 'server.cjs'), to: 'server.cjs', script: 'build:mcp' }
]

for (const bundle of bundles) {
  if (!existsSync(bundle.from)) {
    console.error(`${bundle.from} is missing - run \`npm run ${bundle.script}\` first`)
    process.exit(2)
  }
}

// The renderer, built for a browser. `daemon/listen.ts` looks for it as the
// sibling of its own bundle, so `lib/gitwarren.cjs` finds `web/` by walking up
// one - which is the layout below and the reason `web` is not under `lib`.
const webBuild = join(root, 'out', 'web')
if (!existsSync(join(webBuild, 'index.html'))) {
  console.error(`${webBuild} is missing - run \`npm run build:web\` first`)
  process.exit(2)
}

const work = join(root, 'out', 'daemon-tarball', 'work', target)
const stage = join(work, 'gitwarren-daemon')
rmSync(work, { recursive: true, force: true })
mkdirSync(join(stage, 'bin'), { recursive: true })
mkdirSync(join(stage, 'lib'), { recursive: true })

// 1. Node itself, from the official distribution. Cached across runs.
const nodeArchive = join(root, 'out', 'daemon-tarball', `node-${nodeVersion}-${target}.tar.xz`)
if (!existsSync(nodeArchive)) {
  mkdirSync(join(root, 'out', 'daemon-tarball'), { recursive: true })
  const url = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-${target}.tar.xz`
  console.log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  await pipeline(response.body, createWriteStream(nodeArchive))
}
execFileSync('tar', [
  'xJf',
  nodeArchive,
  '-C',
  work,
  '--strip-components=2',
  `node-${nodeVersion}-${target}/bin/node`
])
cpSync(join(work, 'node'), join(stage, 'bin', 'node'))
chmodSync(join(stage, 'bin', 'node'), 0o755)

// 2. The bundles, the addon, the migrations and the web build.
for (const bundle of bundles) cpSync(bundle.from, join(stage, 'lib', bundle.to))

// Resolved rather than assumed to be at `<root>/node_modules`. npm hoists, a
// git worktree has no `node_modules` of its own and reaches the checkout's, and
// both of those are ordinary ways to run this script - so ask Node where the
// package is instead of guessing, and fail with the resolver's own message when
// it is genuinely absent.
const sqliteRoot = dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json'))

const prebuild = join(sqliteRoot, 'prebuilds', `${target}.node`)
if (!existsSync(prebuild)) throw new Error(`no better-sqlite3 prebuild for ${target} at ${prebuild}`)
// Both bundles do `require('better-sqlite3')`, whose lib/binding.js looks for a
// prebuild at prebuilds/<platform>-<arch>.node relative to the package, which
// is exactly how it ships in node_modules - so the package is reproduced with
// only the one prebuild that matters.
const pkg = join(stage, 'lib', 'node_modules', 'better-sqlite3')
mkdirSync(join(pkg, 'prebuilds'), { recursive: true })
cpSync(prebuild, join(pkg, 'prebuilds', `${target}.node`))
cpSync(join(sqliteRoot, 'lib'), join(pkg, 'lib'), { recursive: true })
cpSync(join(sqliteRoot, 'package.json'), join(pkg, 'package.json'))
cpSync(join(root, 'drizzle'), join(stage, 'drizzle'), { recursive: true })
cpSync(webBuild, join(stage, 'web'), { recursive: true })

/**
 * Outside Electron there is no `resourcesPath` and no project root to walk up
 * to, so the migrations folder and the web build have to be named explicitly.
 * Both launchers do it the same way, from their own location, so the directory
 * works wherever it is unpacked - `/opt`, a Homebrew Cellar, or a home
 * directory.
 *
 * `GITWARREN_WEB_ROOT` is belt and braces: `resolveWebRoot` would find `web`
 * as the sibling of `lib/gitwarren.cjs` on its own. Naming it means the
 * *reason* it is found is a line in this file rather than a coincidence of
 * layout, and a future change to either survives the other.
 *
 * ## The symlink loop is not decoration
 *
 * `dirname "$0"` is the directory of the *name the script was invoked by*, and
 * `sh` does not resolve a symlink to get it. Homebrew installs this tarball
 * into a Cellar and puts a symlink in `bin`, so `$0` is
 * `/opt/homebrew/bin/gitwarren` and the naive form computes `here` as
 * `/opt/homebrew` - where there is no `lib/gitwarren.cjs`, no `drizzle` and no
 * `web`. Everything would then fail on a path that looks plausible enough to
 * spend an hour on. `readlink` without `-f` is the portable spelling (BSD only
 * grew `-f` recently), so the link is followed one hop at a time, and a
 * relative target is resolved against the directory of the link that named it.
 */
const preamble =
  '#!/bin/sh\n' +
  'self="$0"\n' +
  'while [ -L "$self" ]; do\n' +
  '  link="$(readlink "$self")"\n' +
  '  case "$link" in\n' +
  '    /*) self="$link" ;;\n' +
  '    *) self="$(dirname "$self")/$link" ;;\n' +
  '  esac\n' +
  'done\n' +
  'here="$(cd "$(dirname "$self")/.." && pwd)"\n' +
  'export GITWARREN_MIGRATIONS_DIR="$here/drizzle"\n' +
  'export GITWARREN_WEB_ROOT="$here/web"\n'

// 3. The launcher an agent config points at. The same name the tray app
//    maintains at ~/.gitwarren/bin/gitwarren-mcp, so the one-sentence agent
//    prompt reads identically on a laptop and on a VPS.
writeFileSync(
  join(stage, 'bin', 'gitwarren-mcp'),
  preamble + 'exec "$here/bin/node" "$here/lib/server.cjs" "$@"\n'
)
chmodSync(join(stage, 'bin', 'gitwarren-mcp'), 0o755)

// 4. The CLI. Every subcommand, because there is now a real one behind this
//    name: `serve`, `open` and `service install`, parsed in `src/cli/`. Until
//    M3.3 this file did the parsing itself in `sh` and accepted only `serve`,
//    which was honest about there being nothing else to accept.
//
//    `gitwarren service install` run from an unpacked tarball copies this
//    resolution into ~/.gitwarren/bin/gitwarren - it reads `process.execPath`
//    and `argv[1]`, which are `bin/node` and `lib/gitwarren.cjs` here, plus the
//    two variables exported above. That is why the launcher exports them rather
//    than passing them on the command line.
writeFileSync(
  join(stage, 'bin', 'gitwarren'),
  preamble + 'exec "$here/bin/node" "$here/lib/gitwarren.cjs" "$@"\n'
)
chmodSync(join(stage, 'bin', 'gitwarren'), 0o755)

// 5. Pack.
//
//    The name is the contract. M4's installer runs `uname -sm` on a host,
//    maps it to one of these targets, and fetches
//    `gitwarren-daemon-<version>-<target>.tar.gz` from the release by URL -
//    one request, no listing and no search - and the Homebrew formula in
//    `packaging/homebrew` names the same two macOS URLs. So this string is not
//    free to change without changing both.
const out = join(root, 'out', 'daemon-tarball', `gitwarren-daemon-${version}-${target}.tar.gz`)
execFileSync('tar', ['czf', out, '-C', work, 'gitwarren-daemon'])
// `statSync` rather than `du -h`, which does not exist on Windows: the archive
// was fully built by the line above and the script then died reporting its
// size, which is the most annoying possible place to fail. Same family as the
// `npx.cmd` spawn in `run-tests.mjs` - ci.yml runs ubuntu only, so nothing said
// so until somebody built a tarball on a PC.
const size = statSync(out).size
console.log(`${out} (${(size / 1024 / 1024).toFixed(1)} MB)`)
