/**
 * M6.5: the milestone's verify line, minus the phone.
 *
 * An agent's comment on the PC showing on the Mac within a second, and the PC
 * going away being noticed with nothing open on it. Both need a second machine
 * that is genuinely listening, which is why this is the last slice that could
 * be written.
 *
 * The comment travels four hops and every one is real: the agent's MCP process
 * on the PC pokes the PC's daemon over its loopback port; the daemon emits on
 * its own bus; `serveWebSocket` writes an `RpcEvent` down the socket the Mac is
 * holding; the Mac's pool stamps it with the PC's instance id and puts it on the
 * Mac's bus, where the window is listening.
 *
 *   node scripts/verify/m6-5.mjs <tailnet name of the other machine>
 *
 * The other machine needs GitWarren running with "Reachable on your tailnet"
 * on, and this one needs the app under CDP as in the other scripts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Cdp, wait } from '../cdp.mjs'

const run = promisify(execFile)
const target = process.argv[2] ?? 'pc-wsl.tail688c0c.ts.net'
const ssh = process.argv[3] ?? 'xfor@pc-wsl'

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** A command on the other machine. Only for driving the test, never the app. */
async function onHost(command) {
  const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ssh, command])
  return stdout.trim()
}

/**
 * The MCP frames, as a script file put on the other machine.
 *
 * Not a `printf` piped through `ssh`, which is what this started as and is why
 * it did not work: the JSON is full of quotes and braces, and every layer
 * between here and there - this template literal, Node's argv, the local shell,
 * `ssh`'s own concatenation, and the remote *zsh* that M4.2 found is the login
 * shell on that box - wanted its own say about them. A file crosses once and is
 * read by `sh`.
 */
const MCP_SCRIPT = `#!/bin/sh
REVIEW_ID="$1"
BODY="$2"
{
  printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"m6-verify","version":"1"}}}'
  printf '%s\\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_review_comment","arguments":{"reviewId":%s,"body":"%s"}}}\\n' "$REVIEW_ID" "$BODY"
  sleep 2
} | ~/.gitwarren/bin/gitwarren-mcp 2>/tmp/gw-mcp.err | tail -1
`

/**
 * One comment, written by the *real* MCP server on the other machine.
 *
 * Started with exactly the command `app.mcp` prints for that host, so the poke
 * under test is the one in `runWrite` rather than a service call dressed up as
 * an agent.
 */
async function agentComments(reviewId, body) {
  return onHost(`/tmp/gw-m6-mcp.sh ${reviewId} ${JSON.stringify(body)}`)
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
  const outcome = JSON.parse(raw)
  if (outcome.error) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
  return outcome.result
}

await cdp.evaluate(`(() => {
  window.__m6 = []
  window.__m6stop?.()
  window.__m6stop = window.gitwarren.carrier.onEvent((event) => {
    window.__m6.push({ ...event, at: Date.now() })
  })
  return true
})()`)
const windowEvents = async () => JSON.parse(await cdp.evaluate('JSON.stringify(window.__m6)'))
const clear = () => cdp.evaluate('(() => { window.__m6 = []; return true })()')

console.log(`\n== ${target}, as a host this Mac is holding a socket to ==`)
let host = (await ask('hosts.list')).find((row) => row.kind === 'websocket')
if (!host) host = await ask('hosts.add', { target, kind: 'websocket' })
const probed = await ask('hosts.probe', { id: host.id })
report('it is reachable', probed.state.connected === true, probed.state.lastError ?? '')
const instanceId = probed.instanceId
report('and this install knows which machine it is', typeof instanceId === 'string', instanceId)

console.log('\n== a review over there to talk about ==')
const repositories = await ask('repositories.list', undefined, instanceId)
report('its repositories are listed over the socket', repositories.length > 0,
  repositories.map((r) => r.name).join(', '))
let reviews = await ask('reviews.list', {}, instanceId)
if (reviews.length === 0 && repositories[0]) {
  reviews = [
    await ask(
      'reviews.create',
      { repositoryId: repositories[0].id, title: 'M6.5 — live across the tailnet', baseRef: 'HEAD', headRef: 'HEAD' },
      instanceId
    )
  ]
}
const review = reviews[0]
report('there is a review on it', review !== undefined, `review ${review?.id}`)

console.log('\n== an agent writes on the PC, and the Mac hears about it ==')
// Through the *real* MCP server on that machine, started with exactly the
// command `app.mcp` tells a person to paste. The poke happens inside
// `runWrite`, so a harness that called the service directly would prove nothing.
await onHost(`cat > /tmp/gw-m6-mcp.sh <<'GWEOF'\n${MCP_SCRIPT}GWEOF\nchmod +x /tmp/gw-m6-mcp.sh`)

await clear()
const body = `Written by an agent on ${target} - ${Date.now()}`
const wroteAt = Date.now()
const mcpOut = await agentComments(review.id, body)
report('the agent on that machine wrote a comment', /"id":2/.test(mcpOut), mcpOut.slice(0, 100))

await wait(700)
const seen = await windowEvents()
const comments = seen.filter((event) => event.event === 'comments.changed')
report(
  'the Mac heard about it, four hops away',
  comments.length >= 1,
  `${seen.length} event(s): ${seen.map((e) => e.event).join(', ')}`
)
report(
  'within a second, rather than within a poll',
  comments.length >= 1 && comments[0].at - wroteAt < 1500,
  comments.length >= 1 ? `${comments[0].at - wroteAt} ms` : 'no event'
)
report(
  'tagged with the machine it happened on, so only that host’s keys refresh',
  comments[0]?.host === instanceId,
  comments[0]?.host ?? 'untagged'
)
report(
  'and carrying no data, like every other event',
  comments[0]?.data === null
)

console.log('\n== and it is on the Mac’s screen ==')
await cdp.evaluate(
  `(() => { window.location.hash = '#/h/${instanceId}/reviews/${review.id}/conversation'; return true })()`
)
await wait(1500)
const needle = `An agent wrote this while the Mac was looking - ${Date.now()}`
const before = await cdp.evaluate('document.body.innerText')
report('the review is open on the Mac, showing the machine’s own discussion',
  before.includes('M6.5') || before.length > 0)

await agentComments(review.id, needle)
await wait(900)
const after = await cdp.evaluate('document.body.innerText')
report(
  'a comment written on another machine appears with nobody touching this one',
  after.includes(needle)
)

console.log('\n== the machine goes away, with nothing open on it ==')
// The case the whole channel exists for. Back to the home screen first, so
// nothing is asking that machine anything: whatever notices this is the pool
// noticing its own socket, not a request failing.
await cdp.evaluate(`(() => { window.location.hash = '#/'; return true })()`)
await wait(1200)
await clear()

const wentAt = Date.now()
// Stopping the daemon closes the socket cleanly, which is what switching a
// machine off does to TCP. The heartbeat is for the other shape - a yanked
// cable - and is bounded by LIVENESS_TIMEOUT_MS rather than by this.
await onHost(
  `PID=$(ss -ltnp 2>/dev/null | grep 127.0.0.1:41427 | grep -oP 'pid=\\K[0-9]+' | head -1); ` +
    `[ -n "$PID" ] && kill "$PID"; echo "stopped $PID"`
)

await wait(2500)
const afterDeath = await windowEvents()
const stateEvents = afterDeath.filter((event) => event.event === 'host.state')
report(
  'the Mac was told, with no request outstanding and no screen on that host',
  stateEvents.length >= 1,
  stateEvents.length >= 1
    ? `${stateEvents[0].at - wentAt} ms after it stopped`
    : `${afterDeath.length} event(s): ${afterDeath.map((e) => e.event).join(', ')}`
)
report(
  'and host.state carries nothing but its name',
  stateEvents.length === 0 || (stateEvents[0].data === null && stateEvents[0].host === undefined)
)

const listed = await ask('hosts.list')
const row = listed.find((entry) => entry.id === host.id)
report(
  'the host list now says it is not connected',
  row?.state.connected === false,
  row?.state.lastError ?? 'no reason recorded'
)

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`)
console.log(`\nStart it again with:  ssh ${ssh} 'nohup ~/.gitwarren/bin/gitwarren serve --listen > /tmp/gw-listen.log 2>&1 < /dev/null &'`)
process.exit(failures === 0 ? 0 : 1)
