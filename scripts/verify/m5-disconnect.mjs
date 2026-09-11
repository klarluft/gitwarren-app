/**
 * Pulling the plug on a distribution mid-review.
 *
 * M4.5 built disconnection deliberately carrier-agnostic: it is learned from
 * request *outcomes* in `renderer/lib/host-reachability.ts` and never from the
 * pool, so a WSL host that stops answering should raise the same banner with no
 * new code. That is a claim, and this checks it rather than assuming it.
 *
 * It also records the thing that came out of trying: `wsl --terminate` is *not*
 * the equivalent of killing an `ssh`. It kills the connection, and then the
 * pool's next attempt starts the distribution again - so a terminated
 * distribution is self-healing and there is no banner to see. The durable
 * failure is the one M4.5 itself used: a launcher that is not there.
 *
 *   node scripts/verify/m5-disconnect.mjs [distro]
 */
import { spawn } from 'node:child_process'
import { Cdp, wait, settle } from '../cdp.mjs'

const distro = process.argv[2] ?? 'Ubuntu'
let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const wsl = (args) =>
  new Promise((resolve) => {
    const child = spawn('wsl.exe', args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' }
    })
    child.on('close', resolve)
  })
/** One `sh` command inside the distribution, the way the carrier runs them. */
const inDistro = (command) => wsl(['-d', distro, '-e', 'sh', '-c', command])

const cdp = await Cdp.attach(9222)
const text = () => cdp.evaluate('document.body.innerText')

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

async function waitForText(matcher, seconds = 40) {
  let seen = ''
  for (let i = 0; i < seconds; i += 1) {
    await wait(1000)
    seen = await text()
    if (matcher.test(seen)) return seen
  }
  return seen
}

const host = res(await ask('hosts.list')).find((h) => h.kind === 'wsl' && h.target === distro)
const repo = res(await ask('repositories.list', undefined, host.instanceId))[0]
const review = res(await ask('reviews.list', { repositoryId: repo.id }, host.instanceId))[0]

console.log(`\n== a review open on ${distro} ==`)
await cdp.evaluate(
  `(() => { window.location.hash = '#/h/${host.instanceId}/reviews/${review.id}/files'; return true })()`
)
await wait(1000)
await settle(cdp)
const before = await text()
report('the review is on screen', before.length > 200, `${before.length} characters`)

console.log(`\n== wsl --terminate ${distro}, which turns out not to be an outage ==`)
await wsl(['--terminate', distro])
await wait(400)
const afterTerminate = await ask('reviews.open', { id: review.id }, host.instanceId)
// This is the finding, asserted rather than worked around. Terminating kills
// the pipe the pool is holding; the pool's next attempt spawns a fresh
// `wsl.exe`, and spawning one *starts the distribution*. There is nothing for
// a banner to say.
report('the next request succeeds, because reconnecting restarts the distro',
  afterTerminate.error === undefined,
  afterTerminate.error ? `${afterTerminate.error.code}` : 'recovered transparently')

console.log('\n== a durable failure: the launcher moved aside ==')
await inDistro('mv ~/.gitwarren/bin/gitwarren ~/.gitwarren/bin/gitwarren.off')
// Moving it is not enough on its own - the pool may be holding a pipe into a
// daemon that is already running, which M4.5 found the same way.
// The daemon runs as `node …/lib/gitwarren.cjs serve --stdio`, so the pattern
  // has to name the script rather than the launcher.
  await inDistro("pkill -f 'gitwarren.cjs serve' || true")
await wait(500)

const failed = await ask('reviews.open', { id: review.id }, host.instanceId)
report('the request fails rather than hanging', failed.error !== undefined,
  `${failed.error?.code}: ${failed.error?.message}`)
report('it is a disconnection, which is what the banner keys off',
  failed.error?.code === 'HOST_OFFLINE')
report('and it says what is actually wrong',
  /not installed/i.test(failed.error?.message ?? ''), failed.error?.message)

console.log('   waiting for the screen to notice…')
const banner = await waitForText(/stopped answering|not answering/i)
report('the banner rose with no code written for this carrier',
  /stopped answering|not answering/i.test(banner),
  banner.split('\n').filter((l) => /answering|loaded at|Try again/i.test(l)).join(' | '))
report('the content underneath was kept', banner.length > 200, `${banner.length} characters`)

console.log('\n== and it comes back on its own ==')
await inDistro('mv ~/.gitwarren/bin/gitwarren.off ~/.gitwarren/bin/gitwarren')
const recovered = await waitForText(/^(?!.*stopped answering)/s, 60)
const stillDown = /stopped answering|not answering/i.test(recovered)
report('the banner clears without anybody pressing anything', !stillDown)

cdp.close()
console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
