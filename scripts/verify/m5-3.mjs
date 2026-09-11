/**
 * M5.3 through the real window: editors, reveal and agent access.
 *
 * The app must already be running with --remote-debugging-port=9222 and have
 * the WSL host added - `m5-app.mjs` leaves it in exactly that state.
 *
 *   node scripts/verify/m5-3.mjs [distro]
 */
import { Cdp, wait } from '../cdp.mjs'
import { editorTargetFor, editorLink } from '../../src/shared/editors.ts'
import { windowsPathForWsl } from '../../src/shared/wsl.ts'

const distro = process.argv[2] ?? 'Ubuntu'
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

const hosts = resultOf(await ask('hosts.list'))
const host = hosts.find((h) => h.kind === 'wsl' && h.target === distro)
if (!host) throw new Error(`no wsl host for ${distro}; run m5-app.mjs first`)
report('the wsl host is there with an instance id', typeof host.instanceId === 'string', host.instanceId)

console.log('\n== the editor form ==')
const remote = editorTargetFor(host)
report('a WSL host derives wsl+<distro>', remote === `wsl+${distro}`, remote)
report('editor_target is still NULL, so it is derived not stored', host.editorTarget === null)

const repositories = resultOf(await ask('repositories.list', undefined, host.instanceId))
const repository = repositories[0]
report('there is a repository to open', repository !== undefined, repository?.path)

const reviews = resultOf(
  await ask('reviews.list', { repositoryId: repository.id }, host.instanceId)
)
report('and a review on it', reviews.length > 0, `${reviews.length} reviews`)

if (reviews.length > 0) {
  // `reviews.diff` and `reviews.filePath` take `{ id, changes }`, not a
  // `reviewId` - every method here names its object as `id`.
  const review = reviews[0]
  const diff = resultOf(await ask('reviews.diff', { id: review.id }, host.instanceId))
  const first = diff.files?.[0]?.path
  if (first) {
    const filePath = resultOf(
      await ask('reviews.filePath', { id: review.id, path: first }, host.instanceId)
    )
    report('reviews.filePath answers a distro path', filePath.startsWith('/home/'), filePath)
    const url = editorLink('vscode').remoteUrl(remote, filePath, 1)
    report('which becomes a vscode://vscode-remote/wsl+ URL', url.includes('/wsl+'), url)
    console.log('    (open this by hand to prove the extension resolves it)')
  } else {
    report('the review has a file to point at', false, 'no files in the diff')
  }
}

console.log('\n== the Explorer reveal ==')
const revealed = windowsPathForWsl(distro, repository.path)
report('a distro path becomes a UNC path', revealed.startsWith('\\\\wsl.localhost\\'), revealed)
const exists = await cdp.evaluate('true')
report('the renderer is alive to be asked', exists === true)

// Whether the window would actually draw the button: the hook's two conditions.
const info = await cdp.evaluate(`(async () => {
  const i = await window.gitwarren.shell.system.appInfo()
  return JSON.stringify({ platform: i.platform, reveal: window.gitwarren.shell.capabilities.revealPath })
})()`)
const { platform, reveal } = JSON.parse(info)
report('the core is on Windows and the shell can reveal', platform === 'win32' && reveal === true,
  `platform=${platform} revealPath=${reveal}`)

console.log('\n== agent access, per host ==')
const mcp = resultOf(await ask('app.mcp', undefined, host.instanceId))
report('app.mcp answers the distro launcher', mcp.command.startsWith('/home/'), mcp.command)
const localMcp = resultOf(await ask('app.mcp'))
report('and this machine answers a Windows one', /^[A-Za-z]:\\/.test(localMcp.command), localMcp.command)
report('the two are different machines', mcp.command !== localMcp.command)

await wait(200)
cdp.close()
console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
