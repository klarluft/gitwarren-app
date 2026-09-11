/**
 * The native Windows half of M5's verify line: "native Windows repos
 * unaffected", and the clone grouping that only works if both halves are right.
 *
 * The PC has the same project checked out twice - once on NTFS and once inside
 * Ubuntu - which is the arrangement this milestone is for, and the two share a
 * root commit and nothing else. M4.3 built the grouping for exactly this and
 * had to test it across a network; here it is one machine.
 *
 *   node scripts/verify/m5-local.mjs
 */
import { Cdp } from '../cdp.mjs'

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const cdp = await Cdp.attach(9222)
async function ask(method, params, host) {
  const payload = JSON.stringify({ method, params: params ?? null, host: host ?? null })
  const raw = await cdp.evaluate(`(async () => {
    const { method, params, host } = ${payload}
    const o = await window.gitwarren.carrier.request(
      method, params === null ? undefined : params, host === null ? undefined : host)
    return JSON.stringify(o)
  })()`)
  return JSON.parse(raw)
}
const res = (o) => {
  if (o.error) throw new Error(`${o.error.code}: ${o.error.message}`)
  return o.result
}

const WINDOWS_CHECKOUT = 'C:\\Users\\micha\\gitwarren-app'

console.log('\n== a native Windows repository ==')
const existing = res(await ask('repositories.list'))
let local = existing.find((r) => r.path.toLowerCase() === WINDOWS_CHECKOUT.toLowerCase())
if (!local) {
  local = res(await ask('repositories.add', { path: WINDOWS_CHECKOUT }))
}
report('a C:\\ path is added as a local repository', local.path === WINDOWS_CHECKOUT, local.path)

const withState = res(await ask('repositories.get', { id: local.id }))
report('its git state reads on NTFS', withState.git.isGitRepository === true,
  `branch=${withState.git.branch} root=${withState.git.rootCommit?.slice(0, 12)}`)

console.log('\n== the same project, in the distro ==')
const host = res(await ask('hosts.list')).find((h) => h.kind === 'wsl')
const remote = res(await ask('repositories.list', undefined, host.instanceId))
const twin = remote.find((r) => r.git.rootCommit === withState.git.rootCommit)
report('one of the distro repositories shares its root commit', twin !== undefined,
  `${twin?.path} @ ${twin?.git.rootCommit?.slice(0, 12)}`)
report('and it is a different path on a different filesystem',
  twin !== undefined && twin.path.startsWith('/home/'), twin?.path)

console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
cdp.close()
process.exit(failures === 0 ? 0 : 1)
