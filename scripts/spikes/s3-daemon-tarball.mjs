/**
 * Spike S3 from docs/across-hosts.md: can a self-contained tarball run the
 * GitWarren core on a Linux box with nothing installed?
 *
 * There is no daemon yet, so the payload is the MCP server - the same bundle,
 * the same native addon, the same migrations the daemon will need. If this
 * answers an MCP `initialize` over stdio in a bare container, the daemon will
 * run there too.
 *
 * The tarball is: the official Node binary for the target, `server.cjs` from
 * `npm run build:mcp`, the matching `better_sqlite3.node` prebuild that
 * better-sqlite3 already ships in node_modules, the drizzle migrations, and a
 * `gitwarren-mcp` launcher script. Nothing is compiled here.
 *
 *   npm run build:mcp
 *   node scripts/spikes/s3-daemon-tarball.mjs linux-x64
 *   node scripts/spikes/s3-daemon-tarball.mjs linux-arm64
 *
 * Then prove it in a container that has no Node (Docker calls x64 "amd64"):
 *
 *   INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"s3","version":"0"}}}'
 *   printf '%s\n' "$INIT" | docker run --rm -i --platform linux/arm64 \
 *     -v "$PWD/out/daemon-tarball:/t:ro" ubuntu:24.04 \
 *     sh -c 'tar xzf /t/gitwarren-daemon-*-linux-arm64.tar.gz -C /opt && HOME=/root /opt/gitwarren-daemon/bin/gitwarren-mcp'
 *
 * Pass: a JSON `result` with `serverInfo.name` comes back and the container
 * exits cleanly. That means Node ran, the addon loaded, the database was
 * created and migrated, and the protocol answered.
 */
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const target = process.argv[2]
if (!/^linux-(x64|arm64)$/.test(target ?? '')) {
  console.error('usage: node scripts/spikes/s3-daemon-tarball.mjs linux-x64|linux-arm64')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..', '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
// The Node version to embed. Pinned to the major the app is built against; the
// exact release is whatever nodejs.org lists as current for that line.
const nodeVersion = process.env.NODE_TARBALL_VERSION ?? 'v24.20.0'
const server = join(root, 'out', 'mcp', 'server.cjs')
if (!existsSync(server)) {
  console.error('out/mcp/server.cjs is missing - run `npm run build:mcp` first')
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
  const url = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-${target}.tar.xz`
  console.log(`downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  await pipeline(response.body, createWriteStream(nodeArchive))
}
execFileSync('tar', ['xJf', nodeArchive, '-C', work, '--strip-components=2', `node-${nodeVersion}-${target}/bin/node`])
cpSync(join(work, 'node'), join(stage, 'bin', 'node'))
chmodSync(join(stage, 'bin', 'node'), 0o755)

// 2. The bundle, the addon and the migrations.
cpSync(server, join(stage, 'lib', 'server.cjs'))
const prebuild = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', `${target}.node`)
if (!existsSync(prebuild)) throw new Error(`no better-sqlite3 prebuild for ${target} at ${prebuild}`)
// server.cjs does `require('better-sqlite3')`, whose lib/binding.js looks for a
// prebuild at prebuilds/<platform>-<arch>.node relative to the package, which
// is exactly how it ships in node_modules - so the package is reproduced with
// only the one prebuild that matters.
const pkg = join(stage, 'lib', 'node_modules', 'better-sqlite3')
mkdirSync(join(pkg, 'prebuilds'), { recursive: true })
cpSync(prebuild, join(pkg, 'prebuilds', `${target}.node`))
cpSync(join(root, 'node_modules', 'better-sqlite3', 'lib'), join(pkg, 'lib'), { recursive: true })
cpSync(join(root, 'node_modules', 'better-sqlite3', 'package.json'), join(pkg, 'package.json'))
cpSync(join(root, 'drizzle'), join(stage, 'drizzle'), { recursive: true })

// 3. The launcher an agent config points at.
writeFileSync(
  join(stage, 'bin', 'gitwarren-mcp'),
  '#!/bin/sh\n' +
    'here="$(cd "$(dirname "$0")/.." && pwd)"\n' +
    // Outside Electron there is no resourcesPath and no project root to walk
    // up to, so the migrations folder is named explicitly.
    'export GITWARREN_MIGRATIONS_DIR="$here/drizzle"\n' +
    'exec "$here/bin/node" "$here/lib/server.cjs" "$@"\n'
)
chmodSync(join(stage, 'bin', 'gitwarren-mcp'), 0o755)

// 4. Pack.
const out = join(root, 'out', 'daemon-tarball', `gitwarren-daemon-${version}-${target}.tar.gz`)
execFileSync('tar', ['czf', out, '-C', work, 'gitwarren-daemon'])
const size = execFileSync('du', ['-h', out], { encoding: 'utf8' }).split('\t')[0]
console.log(`${out} (${size})`)
