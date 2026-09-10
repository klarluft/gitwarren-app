/**
 * The self-contained daemon tarball, as a release asset.
 *
 * Promoted from `scripts/spikes/s3-daemon-tarball.mjs`, which proved the idea
 * on 10 September 2026: a Node binary, the bundles, the one matching
 * `better_sqlite3.node` and the migrations, in a tarball that runs on a Linux
 * box with nothing installed. See spike S3 in docs/across-hosts.md.
 *
 * The spike predated the daemon and carried only the MCP server. This carries
 * both, because the two things a remote host has to be able to do are answer a
 * GitWarren on another machine (`serve.cjs`, over a pipe) and be reached by the
 * agent working next to the code (`server.cjs`, over stdio) - and rule 6 says
 * those are different processes with different callers.
 *
 * Nothing is compiled. better-sqlite3 ships prebuilds for both Linux
 * architectures, so a tarball for either can be built from any machine that can
 * run `npm ci` - which is what lets one ubuntu runner produce both.
 *
 *   npm run build:mcp && npm run build:daemon
 *   node scripts/build-daemon-tarball.mjs linux-x64
 *   node scripts/build-daemon-tarball.mjs linux-arm64
 *
 * Prove one in a container with no Node (Docker calls x64 "amd64"):
 *
 *   printf '{"id":1,"method":"repositories.list"}\n' | docker run --rm -i \
 *     --platform linux/arm64 -v "$PWD/out/daemon-tarball:/t:ro" ubuntu:24.04 \
 *     sh -c 'tar xzf /t/gitwarren-daemon-*-linux-arm64.tar.gz -C /opt &&
 *            HOME=/root /opt/gitwarren-daemon/bin/gitwarren serve --stdio'
 */
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const target = process.argv[2]
if (!/^linux-(x64|arm64)$/.test(target ?? '')) {
  console.error('usage: node scripts/build-daemon-tarball.mjs linux-x64|linux-arm64')
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
  { from: join(root, 'out', 'daemon', 'serve.cjs'), to: 'serve.cjs', script: 'build:daemon' },
  { from: join(root, 'out', 'mcp', 'server.cjs'), to: 'server.cjs', script: 'build:mcp' }
]

for (const bundle of bundles) {
  if (!existsSync(bundle.from)) {
    console.error(`${bundle.from} is missing - run \`npm run ${bundle.script}\` first`)
    process.exit(2)
  }
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

// 2. The bundles, the addon and the migrations.
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

/**
 * Outside Electron there is no `resourcesPath` and no project root to walk up
 * to, so the migrations folder has to be named explicitly. Both launchers do
 * it the same way, from their own location, so the directory can be unpacked
 * anywhere.
 */
const preamble =
  '#!/bin/sh\n' +
  'here="$(cd "$(dirname "$0")/.." && pwd)"\n' +
  'export GITWARREN_MIGRATIONS_DIR="$here/drizzle"\n'

// 3. The launcher an agent config points at. The same name the tray app
//    maintains at ~/.gitwarren/bin/gitwarren-mcp, so the one-sentence agent
//    prompt reads identically on a laptop and on a VPS.
writeFileSync(
  join(stage, 'bin', 'gitwarren-mcp'),
  preamble + 'exec "$here/bin/node" "$here/lib/server.cjs" "$@"\n'
)
chmodSync(join(stage, 'bin', 'gitwarren-mcp'), 0o755)

// 4. The launcher a GitWarren on another machine spawns.
//
//    One subcommand, because one is all there is: M4 spawns
//    `~/.gitwarren/bin/gitwarren serve --stdio` over ssh, and that line should
//    work against this tarball rather than against a name invented later. The
//    rest of the CLI - `open`, `service install` - is M3's to design, and this
//    says so rather than guessing at it.
writeFileSync(
  join(stage, 'bin', 'gitwarren'),
  preamble +
    'if [ "$1" != "serve" ]; then\n' +
    '  echo "usage: gitwarren serve --stdio" >&2\n' +
    '  exit 2\n' +
    'fi\n' +
    'shift\n' +
    'exec "$here/bin/node" "$here/lib/serve.cjs" "$@"\n'
)
chmodSync(join(stage, 'bin', 'gitwarren'), 0o755)

// 5. Pack.
//
//    The name is the contract. M4's installer runs `uname -sm` on a host,
//    maps it to one of these two targets, and fetches
//    `gitwarren-daemon-<version>-<target>.tar.gz` from the release by URL -
//    one request, no listing and no search - so this string is not free to
//    change without changing that.
const out = join(root, 'out', 'daemon-tarball', `gitwarren-daemon-${version}-${target}.tar.gz`)
execFileSync('tar', ['czf', out, '-C', work, 'gitwarren-daemon'])
const size = execFileSync('du', ['-h', out], { encoding: 'utf8' }).split('\t')[0]
console.log(`${out} (${size})`)
