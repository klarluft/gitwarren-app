/**
 * M5.1 against the real distribution, through the shipping carrier.
 *
 * Not a test - `node --test` runs those, and none of them touches WSL. This is
 * the thing M4.1 did by hand before writing anything and then again afterwards:
 * point the code that ships at a machine that really exists and read what comes
 * back. Every interesting bug in M4 was found this way and none of them by a
 * test passing.
 *
 *   node --import tsx scripts/verify-m5-1.mjs [distro]
 */
import { connectOverWsl } from '../src/core/hosts/wsl.ts'
import { createHostPool } from '../src/core/hosts/pool.ts'

const distro = process.argv[2] ?? 'Ubuntu'
let failures = 0

function report(label, ok, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function timed(fn) {
  const started = Date.now()
  const value = await fn()
  return [value, Date.now() - started]
}

console.log(`\n== the carrier, against ${distro} ==`)

{
  const connection = connectOverWsl({ distro })
  const [repositories, cold] = await timed(() => connection.request('repositories.list'))
  report('a cold connection answers repositories.list', Array.isArray(repositories), `${cold} ms, ${repositories.length} repositories`)

  const [instance, warm] = await timed(() => connection.request('app.instance'))
  report('the distro says who it is', typeof instance.instanceId === 'string', `${instance.instanceId} running ${instance.version}, ${warm} ms warm`)

  // Out-of-order answers are the property `id` exists for. M4.1 found this the
  // first thing a hand-rolled client would have got wrong.
  const both = await Promise.all([
    connection.request('app.instance'),
    connection.request('repositories.list')
  ])
  report('two questions in flight at once both come back', both.length === 2 && typeof both[0].instanceId === 'string')

  // A method the daemon answers "no" to must survive the wire as itself.
  let code = null
  try {
    await connection.request('repositories.get', { id: 999999 })
  } catch (error) {
    code = error.code
  }
  report('a NOT_FOUND crosses the pipe as a NOT_FOUND', code === 'NOT_FOUND', `code=${code}`)

  // The rule that is enforced by the carrier itself.
  let localOnly = null
  try {
    await connection.request('hosts.list')
  } catch (error) {
    localOnly = error.code
  }
  report('hosts.list is refused by the carrier', localOnly === 'INVALID_INPUT', `code=${localOnly}`)

  connection.close()
  report('the connection is closed afterwards', !connection.isOpen())
}

console.log('\n== the failure shapes ==')

{
  const connection = connectOverWsl({ distro: 'no-such-distro-here' })
  const started = Date.now()
  let failed = false
  try {
    await connection.request('repositories.list')
  } catch {
    failed = true
  }
  const reason = await connection.diagnostics()
  report('a distribution that is not installed fails fast', failed, `${Date.now() - started} ms`)
  report('  and says what wsl.exe said', /no distribution with the supplied name/i.test(reason), JSON.stringify(reason))
  connection.close()
}

console.log('\n== the pool picks the carrier ==')

{
  const pool = createHostPool()
  const route = { id: 1, kind: 'wsl', target: distro }
  const [state, ms] = await timed(() => pool.probe(route))
  report('a wsl route probes through the pool', state.connected === true, `${ms} ms, failures=${state.failures}`)

  const bad = { id: 2, kind: 'wsl', target: 'no-such-distro-here' }
  const badState = await pool.probe(bad)
  report('an unreachable distro is a state, not a throw', badState.connected === false, JSON.stringify(badState.lastError))
  pool.disconnectAll()
}

console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
