/**
 * M6.6: "the PC appears on the Mac with no configuration".
 *
 * The first half of the milestone's verify line, and the half where the
 * interesting question is what it *costs* rather than whether it works. This
 * tailnet has four nodes - two machines that could be hosts, one that is this
 * one, and a phone - which is a small version of exactly the shape the plan
 * worried about: nine peers of which one is a GitWarren.
 *
 * So the run is timed, and the phone is in it on purpose.
 *
 *   node scripts/verify/m6-6.mjs
 */
import { Cdp } from '../cdp.mjs'

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
    const outcome = await window.gitwarren.carrier.request(method, params === null ? undefined : params)
    return JSON.stringify(outcome)
  })()`)
  const outcome = JSON.parse(raw)
  if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
  return outcome.result
}

console.log('\n== nothing configured ==')
for (const row of await ask('hosts.list')) await ask('hosts.remove', { id: row.id })
report('the host list is empty', (await ask('hosts.list')).length === 0)

console.log('\n== what is on the tailnet ==')
const startedAt = Date.now()
const peers = await ask('hosts.discover')
const took = Date.now() - startedAt
console.log('  ', JSON.stringify(peers))
report('a machine running GitWarren was found with nothing typed', peers.length >= 1,
  peers.map((p) => p.dnsName).join(', '))
report(
  'and it said who it is, which is the only thing that can tell two names for one box apart',
  peers.every((p) => typeof p.instanceId === 'string' && p.instanceId.length > 0)
)
report(
  'this machine is not proposed to itself',
  !peers.some((p) => p.dnsName.startsWith('mac.')),
  'excluded by instance id, not by name'
)
report(
  'the whole scan is bounded by the probe timeout, not by the number of peers',
  took < 2500,
  `${took} ms for every online peer, in parallel`
)

console.log('\n== adding one is a person pressing a button ==')
const peer = peers[0]
const added = await ask('hosts.add', {
  target: peer.origin,
  kind: 'websocket',
  label: peer.dnsName.split('.')[0]
})
report('the proposal becomes a row', added.kind === 'websocket', `${added.label} — ${added.target}`)
report(
  'stored as the origin the probe answered at, so nothing about the scheme is guessed',
  added.target === peer.origin,
  added.target
)

const probed = await ask('hosts.probe', { id: added.id })
report('and it works straight away', probed.state.connected === true,
  probed.instanceId ?? probed.state.lastError ?? '')
report('with the instance id discovery already knew', probed.instanceId === peer.instanceId)

console.log('\n== and it now says you have it ==')
const again = await ask('hosts.discover')
const same = again.find((p) => p.instanceId === peer.instanceId)
report('the same machine is still listed rather than silently dropped', same !== undefined)
report(
  'named as the row it is already in the list as, not just greyed',
  same?.alreadyAdded === added.label,
  same?.alreadyAdded ?? 'null'
)

console.log('\n== a machine reached another way is the same machine ==')
// The case M5.2 settled and this is the earliest point it can be caught. An
// `ssh` row for the same box collides on instance id; discovery has the id in
// hand from the probe, so it can say so before anybody presses anything.
await ask('hosts.remove', { id: added.id })
const ssh = await ask('hosts.add', { target: 'xfor@pc-wsl', kind: 'ssh' })
await ask('hosts.probe', { id: ssh.id })
const third = await ask('hosts.discover')
const collided = third.find((p) => p.instanceId === peer.instanceId)
report(
  'a tailnet peer already added over SSH is reported as already added',
  collided?.alreadyAdded !== null && collided?.alreadyAdded !== undefined,
  collided?.alreadyAdded ?? 'offered as new, which would be two rows for one box'
)
await ask('hosts.remove', { id: ssh.id })

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
