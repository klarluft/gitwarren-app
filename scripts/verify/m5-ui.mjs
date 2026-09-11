/**
 * The screens, at a desktop width and at 390 px.
 *
 * Two things are being checked and they are not the same. One is that the
 * controls M5 changed are drawn where they should be and absent where they
 * should not - the carrier choice, the distro picker, and the reveal button
 * that M4.3 hid and M5.3 brings back for exactly one arrangement. The other is
 * M3.5's rule: `scrollWidth === clientWidth` at 390 px. M4.5 recorded that the
 * second check is necessary and says nothing about whether anybody can read the
 * result, so the text is printed too.
 *
 *   node scripts/verify/m5-ui.mjs
 */
import { Cdp, wait, settle } from '../cdp.mjs'

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const cdp = await Cdp.attach(9222)
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')

/** Console errors and warnings, collected for the whole run. */
const noise = []
cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
  if (type === 'error' || type === 'warning') {
    noise.push(`${type}: ${args.map((a) => a.value ?? a.description ?? '?').join(' ')}`)
  }
})
cdp.on('Log.entryAdded', ({ entry }) => {
  if (entry.level === 'error') noise.push(`log: ${entry.text}`)
})

async function go(hash) {
  await cdp.evaluate(`(() => { window.location.hash = ${JSON.stringify(hash)}; return true })()`)
  await wait(400)
  await settle(cdp)
}

const text = () => cdp.evaluate('document.body.innerText')
const setWidth = (width) =>
  cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })

console.log('\n== the Hosts screen ==')
await setWidth(1200)
await go('#/hosts')
const hostsText = await text()
report('the WSL host is listed', hostsText.includes('Ubuntu'), hostsText.split('\n').slice(0, 6).join(' | '))

console.log('\n== the Add dialog ==')
// Press Add, then read what the dialog offers.
await cdp.evaluate(`(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => /add host/i.test(b.textContent ?? ''))
  if (button) button.click()
  return Boolean(button)
})()`)
await wait(700)
const dialog = await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  return d ? d.innerText : ''
})()`)
report('the carrier choice is offered', /Connect by/i.test(dialog))
report('both carriers are there', /SSH/.test(dialog) && /WSL/.test(dialog))
report('the SSH form is the default', /SSH host/i.test(dialog))

// Switch to WSL and read the picker.
await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const wsl = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'WSL')
  if (wsl) wsl.click()
  return Boolean(wsl)
})()`)
await wait(700)
const wslDialog = await cdp.evaluate(`(() => document.querySelector('[role="dialog"]').innerText)()`)
report('the picker lists distributions', /Distribution/i.test(wslDialog))
report('Ubuntu is shown as already added', /already added/i.test(wslDialog))
report('the docker distros are offered too', /docker-desktop/.test(wslDialog))
report('the SSH text field is gone', !/SSH host/i.test(wslDialog))
console.log('   dialog:', JSON.stringify(wslDialog.replace(/\n+/g, ' | ').slice(0, 300)))

// Narrow, with the dialog open, because a dialog is the easiest thing to
// overflow and M4.5's note is about exactly this check being insufficient.
await setWidth(390)
await wait(500)
const narrowDialog = await cdp.evaluate(`(() => {
  const e = document.documentElement
  return JSON.stringify({ scroll: e.scrollWidth, client: e.clientWidth })
})()`)
const narrow = JSON.parse(narrowDialog)
report('no horizontal scroll at 390 px with the dialog open', narrow.scroll === narrow.client,
  `scrollWidth=${narrow.scroll} clientWidth=${narrow.client}`)

// Close it.
await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const cancel = [...d.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? ''))
  if (cancel) cancel.click()
  return true
})()`)
await wait(500)

console.log('\n== the reveal button, which is the M5.3 change ==')
await setWidth(1200)
const host = await cdp.evaluate(`(async () => {
  const o = await window.gitwarren.carrier.request('hosts.list')
  const h = o.result.find((x) => x.kind === 'wsl')
  return h.instanceId
})()`)
await go(`#/h/${host}/`)
const remoteList = await cdp.evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
    .map((b) => b.getAttribute('aria-label'))
  return JSON.stringify(buttons)
})()`)
report('a WSL host\'s repositories offer "Show in file manager"',
  /Show in file manager/.test(remoteList), remoteList.slice(0, 200))

await go('#/')
const localList = await cdp.evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button[aria-label]')]
    .map((b) => b.getAttribute('aria-label'))
  return JSON.stringify(buttons)
})()`)
report('and so do this machine\'s, as they always did',
  /Show in file manager/.test(localList), localList.slice(0, 160))

console.log('\n== 390 px, on the screens themselves ==')
await setWidth(390)
for (const [label, hash] of [['home', '#/'], ['hosts', '#/hosts'], ['the WSL host', `#/h/${host}/`]]) {
  await go(hash)
  const size = JSON.parse(
    await cdp.evaluate(
      `(() => { const e = document.documentElement; return JSON.stringify({ s: e.scrollWidth, c: e.clientWidth }) })()`
    )
  )
  report(`no horizontal scroll on ${label}`, size.s === size.c, `${size.s} vs ${size.c}`)
}

await cdp.send('Emulation.clearDeviceMetricsOverride')
await wait(300)

console.log('\n== console ==')
report('no console errors or warnings', noise.length === 0, noise.slice(0, 5).join(' / '))

cdp.close()
console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
