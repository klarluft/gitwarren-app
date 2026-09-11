/**
 * M6.3: the second authority, and who is allowed through it.
 *
 * Against the real tailnet, because a mock would have agreed with whatever the
 * gate happened to do. What is actually being checked is a set of refusals -
 * the wrong login, the wrong origin, a token where a token is no longer the
 * question - and a refusal is exactly the thing a fake is worst at.
 *
 * The identity header cannot be forged by `fetch`: `Tailscale-User-Login` and
 * `Host` are both forbidden header names, so undici drops an override silently.
 * That is correct browser behaviour and useless here, so the raw `http` client
 * is used for everything - which also means this script is testing the same way
 * `web-handler.test.ts` had to for the `Host` check.
 *
 * Start the app first, in another terminal:
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-m6 \
 *     ./node_modules/.bin/electron . --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/gw-m6-chrome
 *
 * then: node scripts/verify/m6-3.mjs
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { Cdp, wait } from '../cdp.mjs'

const dataDirectory = process.env.GITWARREN_DATA_DIR
if (!dataDirectory) {
  console.error('GITWARREN_DATA_DIR must name the directory the app under test is using.')
  process.exit(2)
}

const PORT = 41427
let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const token = readFileSync(join(dataDirectory, 'web-token'), 'utf8').trim()

/**
 * A request with the headers exactly as given, `Host` included.
 *
 * Always to 127.0.0.1, whatever the `Host` says - which is not a shortcut, it
 * is the arrangement being tested. `tailscale serve` proxies from the tailnet
 * *to loopback*, so a request from a phone arrives on this socket with a
 * tailnet `Host`, and there is nothing else to tell the two apart. Measured in
 * M6.0.
 */
function raw(path, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: PORT, path, method, headers },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body })
        )
      }
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

const cdp = await Cdp.attach(9222)
const ask = async (method, params) => {
  const payload = JSON.stringify({ method, params: params ?? null })
  const raw = await cdp.evaluate(`(async () => {
    const { method, params } = ${payload}
    const outcome = await window.gitwarren.carrier.request(
      method,
      params === null ? undefined : params
    )
    return JSON.stringify(outcome)
  })()`)
  const outcome = JSON.parse(raw)
  if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
  return outcome.result
}

console.log('\n== what this machine knows about its tailnet ==')
const before = await ask('hosts.tailnet')
console.log('  ', JSON.stringify(before))
report('the app can read its own tailnet identity', before.available === true)
report('it knows its MagicDNS name', typeof before.dnsName === 'string' && before.dnsName.length > 0,
  before.dnsName)
report('and the owner login the gate will demand', typeof before.login === 'string', before.login)

console.log('\n== off by default, and the second authority does not exist ==')
if (before.exposed) await ask('hosts.setTailnetExposure', { exposed: false })
const off = await ask('hosts.tailnet')
report('exposure starts off', off.exposed === false)
report('and there is no webRoot to give out', off.webRoot === null)

const authority = `${off.dnsName}:${PORT}`
const refusedWhileOff = await raw('/app/', {
  host: authority,
  [`tailscale-user-login`]: off.login
})
report(
  'a tailnet-shaped request is refused while the switch is off',
  refusedWhileOff.status === 403,
  `${refusedWhileOff.status}`
)

console.log('\n== turning it on ==')
const on = await ask('hosts.setTailnetExposure', { exposed: true })
console.log('  ', JSON.stringify(on))
report('the machine reports itself exposed', on.exposed === true)
report(
  'with a webRoot that includes the mount, so a phone lands in the app',
  typeof on.webRoot === 'string' && on.webRoot.endsWith('/app/'),
  on.webRoot
)
report(
  'and the scheme is the one that actually happened, not one assumed',
  on.webRoot?.startsWith('http://') || on.webRoot?.startsWith('https://'),
  on.webRoot?.split(':')[0]
)

console.log('\n== the gate, through the second authority ==')
const owner = await raw('/app/', { host: authority, 'tailscale-user-login': on.login })
report('the owner gets the app with no token at all', owner.status === 200, `${owner.status}`)

const stranger = await raw('/app/', {
  host: authority,
  'tailscale-user-login': 'someone-else@github'
})
report('another login is refused', stranger.status === 401, `${stranger.status}`)

const noHeader = await raw('/app/', { host: authority })
report('no identity header at all is refused', noHeader.status === 401, `${noHeader.status}`)

const tokenOnTailnet = await raw(`/app/?token=${encodeURIComponent(token)}`, { host: authority })
report(
  'a token on the tailnet authority does not let anybody in',
  tokenOnTailnet.status === 302 || tokenOnTailnet.status === 401,
  `${tokenOnTailnet.status} — the two questions are not interchangeable`
)
if (tokenOnTailnet.status === 302) {
  const followed = await raw(tokenOnTailnet.headers.location, { host: authority })
  report(
    'and following the redirect still refuses, so no session was minted',
    followed.status === 401,
    `${followed.status}`
  )
}

console.log('\n== and loopback is untouched ==')
const loopbackNoToken = await raw('/app/', { host: `127.0.0.1:${PORT}` })
report('loopback without a session is still 401', loopbackNoToken.status === 401)
const loopbackOwner = await raw('/app/', {
  host: `127.0.0.1:${PORT}`,
  'tailscale-user-login': on.login
})
report(
  'and an identity header on loopback grants nothing',
  loopbackOwner.status === 401,
  `${loopbackOwner.status} — the header is only ever read on the tailnet authority`
)
const loopbackSession = await raw('/app/', {
  host: `127.0.0.1:${PORT}`,
  cookie: `gitwarren_session=${encodeURIComponent(token)}`
})
report('the token still works where the token is the question', loopbackSession.status === 200)

console.log('\n== the poke is loopback-only ==')
const pokeOverTailnet = await raw(
  '/gitwarren/notify',
  {
    host: authority,
    origin: `http://${authority}`,
    'tailscale-user-login': on.login,
    'x-gitwarren-token': token,
    'content-type': 'application/json',
    'content-length': '0'
  },
  'POST'
)
report(
  'a peer cannot tell this install that its own database changed',
  pokeOverTailnet.status === 404,
  `${pokeOverTailnet.status}`
)

console.log('\n== webUrl appears on an MCP result, and only while listening ==')
// Read the published fact rather than the tool result: the runtime file is what
// the MCP process reads, and if it is right the linker is right. The tool
// itself is exercised in m6-2.
const runtime = JSON.parse(readFileSync(join(dataDirectory, 'daemon-runtime.json'), 'utf8'))
report('the owner publishes its webRoot for the MCP process', runtime.webRoot === on.webRoot,
  runtime.webRoot)

await ask('hosts.setTailnetExposure', { exposed: false })
await wait(500)
const afterOff = JSON.parse(readFileSync(join(dataDirectory, 'daemon-runtime.json'), 'utf8'))
report('and takes it away again when the switch goes off', afterOff.webRoot === null,
  String(afterOff.webRoot))
const goneAgain = await raw('/app/', { host: authority, 'tailscale-user-login': on.login })
report('the second authority is gone with it', goneAgain.status === 403, `${goneAgain.status}`)

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
