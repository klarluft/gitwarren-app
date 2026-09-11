/**
 * The guard, typed in the way a person types it.
 *
 * The whole of M5.4 is about a path that *works* - `\\wsl.localhost\…` is a real
 * directory containing a real repository - so the only way to know what the app
 * does with one is to put one in and read what comes back. Which is how the
 * behaviour it replaces was found.
 *
 *   node scripts/verify/m5-4.mjs
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
    const o = await window.gitwarren.carrier.request(method, params === null ? undefined : params)
    return JSON.stringify(o)
  })()`)
  return JSON.parse(raw)
}

const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\xfor\\github.com\\klarluft\\gitwarren-app'

console.log('\n== typing a WSL path into the local add-repository form ==')
const refused = await ask('repositories.add', { path: WSL_REPO })
report('it is refused', refused.error !== undefined, refused.error?.code)
report('and not with the old false sentence',
  !/not inside a git repository/i.test(refused.error?.message ?? ''))
report('it names the distribution', /Ubuntu/.test(refused.error?.message ?? ''))
report('it says to add it as a WSL host',
  /WSL host/i.test(refused.error?.message ?? ''))
report('it says which path to use over there',
  /\/home\/xfor/.test(refused.error?.message ?? ''))
report('the advice lands under the path field',
  Array.isArray(refused.error?.fieldErrors?.path), JSON.stringify(refused.error?.fieldErrors?.path))
console.log('   message:', JSON.stringify(refused.error?.message))

console.log('\n== through the form itself ==')
await cdp.evaluate(`(() => { window.location.hash = '#/'; return true })()`)
await wait(800)
const opened = await cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find((x) => /add repository/i.test(x.textContent ?? ''))
  if (b) b.click()
  return Boolean(b)
})()`)
report('the add dialog opens', opened === true)
await wait(600)

await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const input = d.querySelector('input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(WSL_REPO)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
})()`)
await wait(300)
await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const submit = [...d.querySelectorAll('button')].find((b) => b.type === 'submit')
  if (submit) submit.click()
  return Boolean(submit)
})()`)
await wait(1500)

const shown = await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  return d ? d.innerText : '(dialog closed)'
})()`)
report('the dialog stays open and explains itself', /WSL host/i.test(shown))
console.log('   dialog:', JSON.stringify(shown.replace(/\n+/g, ' | ').slice(0, 320)))

// Close it so the window is left as it was found.
await cdp.evaluate(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const cancel = d ? [...d.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? '')) : null
  if (cancel) cancel.click()
  return true
})()`)

console.log('\n== and the repository was not added ==')
const after = await ask('repositories.list')
const added = (after.result ?? []).some((r) => r.path.toLowerCase().includes('wsl.localhost'))
report('no wsl.localhost row in the local list', !added,
  JSON.stringify((after.result ?? []).map((r) => r.path)))

await wait(200)
cdp.close()
console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
