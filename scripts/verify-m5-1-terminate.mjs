/**
 * The distribution going away underneath an open connection.
 *
 * `wsl --terminate Ubuntu` is M5's equivalent of killing the `ssh` M4.5 pulled
 * the plug on, and it is the one failure whose message this app has to invent:
 * measured, `wsl.exe` ends the pipe and exits 1 without one word on either
 * stream. Separate from `verify-m5-1.mjs` because it shuts the distribution
 * down, which is rude to do in the middle of another check.
 *
 *   node --import tsx scripts/verify-m5-1-terminate.mjs [distro]
 */
import { spawn } from 'node:child_process'
import { connectOverWsl } from '../src/core/hosts/wsl.ts'

const distro = process.argv[2] ?? 'Ubuntu'
let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const connection = connectOverWsl({ distro })
const instance = await connection.request('app.instance')
report('connected before the plug is pulled', typeof instance.instanceId === 'string', instance.instanceId)

console.log(`  running: wsl.exe --terminate ${distro}`)
await new Promise((resolve) => {
  const child = spawn('wsl.exe', ['--terminate', distro], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, WSL_UTF8: '1' }
  })
  child.on('close', resolve)
})

const started = Date.now()
let failed = false
try {
  await connection.request('repositories.list')
} catch (error) {
  failed = true
  report('a request after the shutdown fails rather than hanging', error.code === 'HOST_OFFLINE', `${Date.now() - started} ms, code=${error.code}`)
}
if (!failed) report('a request after the shutdown fails rather than hanging', false, 'it succeeded')

const reason = await connection.diagnostics()
report('the silence is reported as a possible shutdown', /without saying why|shut down/i.test(reason), JSON.stringify(reason))
connection.close()

// And the next connection starts it again, which is what makes this recoverable
// without anybody pressing anything.
const again = connectOverWsl({ distro })
const restarted = Date.now()
const back = await again.request('app.instance')
report('the next connection starts the distribution again', back.instanceId === instance.instanceId, `${Date.now() - restarted} ms cold`)
again.close()

console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
