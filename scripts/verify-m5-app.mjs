/**
 * M5 through the real window, driven over CDP.
 *
 * This is how M4.4 and M4.5 were verified and for the same reason: calling
 * `window.gitwarren.carrier.request` from the renderer puts the preload, the
 * router, the pool and the carrier all in the path, so what is exercised is the
 * shipping arrangement rather than a module imported in isolation.
 *
 * Start the app first, in another terminal:
 *
 *   $env:GITWARREN_DATA_DIR = "$env:TEMP\gw-m5-app"
 *   $env:GITWARREN_DAEMON_TARBALL_DIR = "<worktree>\out\daemon-tarball"
 *   .\node_modules\.bin\electron.cmd . --remote-debugging-port=9222 `
 *     --user-data-dir="$env:TEMP\gw-m5-chrome"
 *
 * then: node scripts/verify-m5-app.mjs [distro]
 */
import { Cdp, wait } from './cdp.mjs'

const distro = process.argv[2] ?? 'Ubuntu'
let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const cdp = await Cdp.attach(9222)

/** One core call, made the way a screen makes it. */
async function ask(method, params, host) {
  // `(method, params, host)`, not a request object: the bridge carrier hands
  // back an `RpcOutcome` as a *value* rather than throwing, because a promise
  // rejected across `contextBridge` loses its code and field errors. See the
  // note at the top of `src/preload/index.ts`.
  const payload = JSON.stringify({ method, params: params ?? null, host: host ?? null })
  const raw = await cdp.evaluate(`(async () => {
    const { method, params, host } = ${payload}
    const outcome = await window.gitwarren.carrier.request(
      method,
      params === null ? undefined : params,
      host === null ? undefined : host
    )
    return JSON.stringify(outcome)
  })()`)
  return JSON.parse(raw)
}

const resultOf = (outcome) => {
  if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
  return outcome.result
}

console.log('\n== the distro list, through the shipping path ==')
const distros = resultOf(await ask('hosts.distros'))
console.log('  ', JSON.stringify(distros))
report('the window can list distributions', distros.length > 0, `${distros.length} found`)
report(`${distro} is among them`, distros.some((d) => d.name === distro))

console.log('\n== adding it as a host ==')
// Start from a clean list so the run is repeatable.
for (const existing of resultOf(await ask('hosts.list'))) {
  resultOf(await ask('hosts.remove', { id: existing.id }))
}
const added = resultOf(await ask('hosts.add', { target: distro, kind: 'wsl' }))
report('a wsl host is added', added.kind === 'wsl' && added.target === distro,
  `id=${added.id}, label=${added.label}`)
report('its label defaults to the distribution name', added.label === distro)
report('it has no instance id until it has been met', added.instanceId === null)

const afterAdd = resultOf(await ask('hosts.distros'))
report('the picker now shows it as already added',
  afterAdd.find((d) => d.name === distro)?.alreadyAdded === true)

console.log('\n== installing into it from the app ==')
const startedInstall = Date.now()
const install = resultOf(await ask('hosts.install', { id: added.id, force: true }))
report('the install ran from the window', install.action === 'installed' || install.action === 'upgraded',
  `${install.action}, ${install.version}, ${(install.bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - startedInstall) / 1000).toFixed(1)} s`)
report('the instance id was learned', typeof install.host.instanceId === 'string',
  install.host.instanceId)
report('the host is reachable afterwards', install.host.state.connected === true)
const instanceId = install.host.instanceId

console.log('\n== it is a machine you can review ==')
const repositories = resultOf(await ask('repositories.list', undefined, instanceId))
report('its repositories list over the carrier', Array.isArray(repositories),
  `${repositories.length} repositories: ${repositories.map((r) => r.path).join(', ')}`)

const listing = resultOf(await ask('fs.list', { path: '~' }, instanceId))
report('fs.list answers with the distro filesystem', listing.separator === '/',
  `${listing.path}, ${listing.entries.length} entries`)

const mcp = resultOf(await ask('app.mcp', undefined, instanceId))
report('app.mcp answers the distro launcher path', mcp.command.startsWith('/home/'), mcp.command)

console.log('\n== one machine, one row ==')
// The same distribution added a second time under a different spelling. It is
// distinct as a *description* and the unique index cannot see it; the instance
// id can, on the first connect.
const other = resultOf(await ask('hosts.add', { target: distro.toLowerCase(), kind: 'wsl' }))
const probed = await ask('hosts.probe', { id: other.id })
const collision = probed.error?.message ?? probed.result?.state?.lastError ?? ''
report('the same distro under another spelling is reported as one machine',
  /same machine as/i.test(collision), JSON.stringify(collision.slice(0, 160)))
resultOf(await ask('hosts.remove', { id: other.id }))

console.log('\n== the ssh form still works as it did ==')
const bad = await ask('hosts.add', { target: 'not a host', kind: 'ssh' })
report('an ssh target keeps its own message',
  /user name, an @/.test(bad.error?.fieldErrors?.target?.[0] ?? ''),
  JSON.stringify(bad.error?.fieldErrors?.target))
const badDistro = await ask('hosts.add', { target: 'no/slashes', kind: 'wsl' })
report('a distro name keeps its own message',
  /distribution name/i.test(badDistro.error?.fieldErrors?.target?.[0] ?? ''),
  JSON.stringify(badDistro.error?.fieldErrors?.target))

console.log('\n== console ==')
await wait(300)
const errors = await cdp.evaluate(`JSON.stringify(window.__m5Errors ?? [])`)
report('no console errors were collected', errors === '[]' || errors === undefined, errors)

cdp.close()
console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
