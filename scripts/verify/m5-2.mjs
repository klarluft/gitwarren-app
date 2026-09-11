/**
 * M5.2 against the real machine: the distro list, and the install over the pipe.
 *
 *   node --import tsx scripts/verify/m5-2.mjs [distro]
 *
 * Needs GITWARREN_DAEMON_TARBALL_DIR pointing at a built linux-x64 tarball, the
 * same way M4.2 to M4.4 were verified - a development build's version is
 * 0.0.0-dev, which no release has ever heard of.
 */
import { readFileSync } from 'node:fs'
import { listDistros } from '../../src/core/hosts/wsl.ts'
import { installOnHost } from '../../src/core/hosts/install.ts'
import { connectOverWsl } from '../../src/core/hosts/wsl.ts'

const distro = process.argv[2] ?? 'Ubuntu'
let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n== the distro list ==')
const found = await listDistros()
console.log('  ', JSON.stringify(found))
report('this machine lists its distributions', found.length > 0, `${found.length} found`)
report('the names are clean, not full of NULs', found.every((d) => !d.name.includes('')))
report('no header row leaked in', !found.some((d) => /^NAME$/i.test(d.name)))
report('the default is marked exactly once', found.filter((d) => d.isDefault).length === 1)
report(`${distro} is in the list`, found.some((d) => d.name === distro))
report('the docker distros are listed, not filtered', found.some((d) => d.name.startsWith('docker-desktop')))

console.log('\n== the install, over the pipe ==')
// Run from source, `APP_VERSION` is `0.0.0-dev` - the constant is stamped in at
// build time and there is no bundle here to stamp it. The packaged app has the
// real one, so the version is read from `package.json` to install exactly what
// the GUI would rather than a string no tarball is named after.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const route = { id: 1, kind: 'wsl', target: distro }
const started = Date.now()
const result = await installOnHost(route, { force: true, version })
const elapsed = Date.now() - started
report('the daemon installed into the distribution', result.action === 'installed' || result.action === 'upgraded',
  `${result.action}, ${result.version}, ${(result.bytes / 1024 / 1024).toFixed(1)} MB in ${(elapsed / 1000).toFixed(1)} s`)
report('the tarball was chosen from uname, not from the carrier', result.target === 'linux-x64', result.target)

console.log('\n== and it answers afterwards ==')
const connection = connectOverWsl({ distro })
const info = await connection.request('app.instance')
report('the freshly installed daemon answers', typeof info.instanceId === 'string',
  `${info.instanceId} running ${info.version}`)
report('it is the version that was just installed', info.version === result.version,
  `${info.version} vs ${result.version}`)
connection.close()

console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
