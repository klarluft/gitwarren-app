/**
 * M6.4: the third carrier, against a machine that is listening.
 *
 * What is under test is `core/hosts/websocket.ts` reaching a daemon through
 * `tailscale serve` - the client, the proxy, the identity header stamped by
 * `tailscaled`, the gate, and a request answered over the socket. The pool's
 * `probe` is the way in, because it goes straight to the carrier rather than
 * through the router, so a host whose instance id happens to be this install's
 * still opens a real connection.
 *
 * Two arrangements, and both are real:
 *
 *   node scripts/verify/m6-4.mjs                  # this machine, over its own
 *                                                 # tailnet name
 *   node scripts/verify/m6-4.mjs pc-wsl           # a second machine
 *
 * The first proves every part of the carrier - there is a genuine tailnet hop,
 * a genuine proxy and a genuine identity check between the two ends, even
 * though both ends are here. The second is the one the milestone is verified on
 * and needs that machine to have "Reachable on your tailnet" turned on.
 *
 * Start the app first, in another terminal:
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-m6 \
 *     ./node_modules/.bin/electron . --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/gw-m6-chrome
 */
import { Cdp, wait } from '../cdp.mjs'

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const cdp = await Cdp.attach(9222)
async function ask(method, params) {
  const payload = JSON.stringify({ method, params: params ?? null })
  const raw = await cdp.evaluate(`(async () => {
    const { method, params } = ${payload}
    const outcome = await window.gitwarren.carrier.request(
      method, params === null ? undefined : params
    )
    return JSON.stringify(outcome)
  })()`)
  const outcome = JSON.parse(raw)
  if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
  return outcome.result
}

console.log('\n== this machine has to be on the tailnet for any of it ==')
const tailnet = await ask('hosts.tailnet')
report('Tailscale is available here', tailnet.available === true)
if (!tailnet.exposed) await ask('hosts.setTailnetExposure', { exposed: true })
const exposed = await ask('hosts.tailnet')
report('and this install is serving', exposed.exposed === true, exposed.webRoot)

const target = process.argv[2] ?? exposed.dnsName
const self = target === exposed.dnsName
console.log(`\n== ${target} as a websocket host ==`)
if (self) {
  console.log('   (this machine, reached over its own tailnet name — a real hop and a real gate)')
}

for (const existing of await ask('hosts.list')) {
  if (existing.kind === 'websocket') await ask('hosts.remove', { id: existing.id })
}

/**
 * One machine is one row, even when two carriers reach it.
 *
 * `pc-wsl` is already an `ssh` row on this Mac from M4, and it is the same box
 * as the tailnet name - so adding it here is the first thing a real fleet does,
 * and it must be refused. M5.2 wrote down why it is refused rather than merged:
 * `#/h/<instance>/…` routes by instance id, and two rows bearing one id make
 * every remote route ambiguous, with a repository list that depends on which
 * row won.
 *
 * Nothing can see the collision until the machine says who it is, so the
 * refusal happens on *connect* rather than in the form - which means the socket
 * really did open and the daemon really did answer before anything was
 * rejected.
 */
const clashing = (await ask('hosts.list')).filter(
  (existing) => existing.kind !== 'websocket' && existing.instanceId !== null
)
if (clashing.length > 0 && !self) {
  console.log('\n== one machine is one row, whichever carrier reaches it ==')
  const clash = await ask('hosts.add', { target, kind: 'websocket' })
  let collision = null
  try {
    await ask('hosts.probe', { id: clash.id })
  } catch (error) {
    collision = String(error)
  }
  report(
    'adding a machine that is already here under another carrier is refused',
    collision !== null && /already in the list/.test(collision),
    collision?.replace(/^Error: /, '').slice(0, 200) ?? 'it was allowed'
  )
  report(
    'and the message names the row it collided with, not just "duplicate"',
    collision !== null && clashing.some((row) => collision.includes(row.target)),
    clashing.map((row) => row.target).join(', ')
  )
  await ask('hosts.remove', { id: clash.id })
  // Out of the way, so the rest of this run is about the carrier rather than
  // about the collision. Two rows for one machine is the thing being refused;
  // one row reached a new way is the thing being tested.
  for (const row of clashing) await ask('hosts.remove', { id: row.id })
}
const host = await ask('hosts.add', { target, kind: 'websocket' })
report('a websocket host is added', host.kind === 'websocket', `id=${host.id}, label=${host.label}`)
report(
  'its target is stored as the origin the carrier will use, not as typed',
  host.target === `http://${target}:41427`,
  host.target
)
report('it has no instance id until it has been met', host.instanceId === null)

console.log('\n== reaching it ==')
const startedAt = Date.now()
const probed = await ask('hosts.probe', { id: host.id })
const took = Date.now() - startedAt
report(
  'the machine answers over the socket',
  probed.state.connected === true,
  `${took} ms${probed.state.lastError ? ` — ${probed.state.lastError}` : ''}`
)
report(
  'and said who it is, so the row is now a known machine',
  typeof probed.instanceId === 'string' && probed.instanceId.length > 0,
  probed.instanceId ?? 'none'
)
report(
  'along with the version it is running',
  typeof probed.daemonVersion === 'string',
  probed.daemonVersion ?? 'none'
)

console.log('\n== the things a carrier is not allowed to do ==')
// `isLocalOnly` is checked in the carrier as well as in the router, and this is
// the belt to that braces: a routing bug must not be able to put a `hosts.`
// method on a wire.
let refused = null
try {
  await ask('hosts.list', undefined, probed.instanceId)
} catch (error) {
  refused = String(error)
}
report(
  'a host list is answered here, never forwarded',
  refused === null,
  'answered locally, as `isAnsweredLocally` requires'
)

console.log('\n== installing onto it is refused, and says why ==')
let installError = null
try {
  await ask('hosts.install', { id: host.id })
} catch (error) {
  installError = String(error)
}
report(
  'a listening host cannot be installed onto from here',
  installError !== null && /FORBIDDEN/.test(installError),
  installError?.slice(0, 180) ?? 'it was allowed'
)

if (!self) {
  console.log('\n== and it is a machine, with repositories on it ==')
  const repositories = await ask('repositories.list', undefined, probed.instanceId)
  report(
    'its repositories are listed over the socket',
    Array.isArray(repositories),
    `${repositories.length} on ${target}`
  )
}

console.log('\n== a machine that is not there ==')
const absent = await ask('hosts.add', { target: 'not-a-machine.tail688c0c.ts.net', kind: 'websocket' })
const absentProbe = await ask('hosts.probe', { id: absent.id })
report(
  'fails fast and says something a person can act on',
  absentProbe.state.connected === false && (absentProbe.state.lastError ?? '').length > 0,
  absentProbe.state.lastError ?? 'no message'
)
await ask('hosts.remove', { id: absent.id })

await wait(200)
console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
