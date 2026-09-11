/**
 * M6.2: an agent's comment reaching the window it was not written in.
 *
 * The agent writes in the *MCP process*, which is a different OS process from
 * the GUI and has its own event bus reaching nobody. So this is the one slice
 * where "did the event arrive" is a question about two processes on one
 * machine, and it needs a real MCP session rather than a socket pretending to
 * be one - the poke happens inside `runWrite`, after the service call, and a
 * harness that called the service directly would prove nothing.
 *
 * Start the app first, in another terminal:
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-m6 \
 *     ./node_modules/.bin/electron . --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/gw-m6-chrome
 *
 * then: node scripts/verify/m6-2.mjs
 */
import { spawn } from 'node:child_process'
import { Cdp, wait } from '../cdp.mjs'

const dataDirectory = process.env.GITWARREN_DATA_DIR
if (!dataDirectory) {
  console.error('GITWARREN_DATA_DIR must name the directory the app under test is using.')
  process.exit(2)
}

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * An MCP session over this repository's own server, through tsx.
 *
 * `npm run mcp:dev` is the same entry point the built launcher runs, and using
 * it here means the poke under test is the one in the working tree rather than
 * whatever was last installed.
 */
function openMcp() {
  const child = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GITWARREN_DATA_DIR: dataDirectory }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    const line = chunk.trim()
    if (line) console.log('   [mcp stderr]', line.slice(0, 160))
  })

  const waiting = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          const settle = waiting.get(message.id)
          if (settle) {
            waiting.delete(message.id)
            settle(message)
          }
        } catch {
          // stdout belongs to the protocol. Anything else here is a bug worth
          // seeing rather than swallowing.
          console.log('   [non-protocol stdout]', JSON.stringify(line.slice(0, 120)))
        }
      }
      newline = buffer.indexOf('\n')
    }
  })

  let id = 0
  const send = (method, params) =>
    new Promise((resolve) => {
      id += 1
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return {
    send,
    notify: (method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    close: () => child.kill()
  }
}

const cdp = await Cdp.attach(9222)
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

console.log('\n== an MCP session against the same data directory ==')
const mcp = openMcp()
const init = await mcp.send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'm6-verify', version: '1' }
})
report('the MCP server answers a handshake', init.result !== undefined,
  `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`)
mcp.notify('notifications/initialized')

const call = async (name, args) => {
  const answer = await mcp.send('tools/call', { name, arguments: args })
  const text = (answer.result?.content ?? []).map((c) => c.text ?? '').join('\n')
  return { isError: answer.result?.isError === true, text }
}

const reviews = await call('list_reviews', {})
const reviewId = Number(/"id":\s*(\d+)/.exec(reviews.text)?.[1] ?? 0)
report('the agent can see a review to talk about', reviewId > 0, `review ${reviewId}`)

console.log('\n== a read from the agent pokes nobody ==')
await clear()
await call('list_reviews', {})
await call('get_review', { id: reviewId })
await wait(400)
report('two agent reads produced no events in the window', (await windowEvents()).length === 0)

console.log('\n== a write from the agent reaches the window ==')
await clear()
const wroteAt = Date.now()
const written = await call('add_review_comment', {
  reviewId,
  body: 'Written by an agent in another process entirely.'
})
report('the agent wrote a comment', !written.isError, written.text.slice(0, 300))

await wait(400)
const seen = await windowEvents()
const comments = seen.filter((event) => event.event === 'comments.changed')
report(
  'the window heard about it',
  comments.length === 1,
  `${seen.length} event(s): ${seen.map((e) => e.event).join(', ')}`
)
report(
  'within a second, rather than within a poll',
  comments.length === 1 && comments[0].at - wroteAt < 1000,
  comments.length === 1 ? `${comments[0].at - wroteAt} ms` : 'no event'
)
report(
  'carrying a name and no content, like every other event',
  comments.length === 1 && comments[0].data === null && comments[0].host === undefined
)

console.log('\n== and it is on screen, which is the whole point ==')
await cdp.evaluate(
  `(() => { window.location.hash = '#/reviews/${reviewId}/conversation'; return true })()`
)
await wait(1200)
// Unique per run: this script is meant to be re-run against a data directory
// it has already written to, and a fixed string would be found by the
// "not yet" check from a previous run's comment.
const needle = `An agent wrote this while somebody was looking — ${Date.now()}`
const before = await cdp.evaluate('document.body.innerText')
report('the conversation is open and does not show it yet', !before.includes(needle))

await call('add_review_comment', { reviewId, body: needle })
await wait(600)
const after = await cdp.evaluate('document.body.innerText')
report('an agent’s comment appears with nobody touching the window', after.includes(needle))

console.log('\n== with no owner there is no poke, and nothing breaks ==')
// The property `core/daemon-runtime.ts` is built on: quit GitWarren and the
// agent keeps working. A poke with nobody listening must be indistinguishable
// from no poke at all - which is also exactly the case of a daemon spawned over
// `ssh`, since a stdio daemon owns nothing and binds nothing.
const stray = spawn('npx', ['tsx', 'src/mcp/server.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  // A data directory nothing owns: no runtime file, so `readLiveDaemonRuntime`
  // answers null and the poke is never attempted.
  env: { ...process.env, GITWARREN_DATA_DIR: '/tmp/gw-m6-unowned' }
})
let strayOut = ''
stray.stdout.setEncoding('utf8')
stray.stdout.on('data', (chunk) => (strayOut += chunk))
stray.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'm6-orphan', version: '1' }
    }
  })}\n`
)
await wait(4000)
stray.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_repositories', arguments: {} }
  })}\n`
)
await wait(3000)
report(
  'an agent against an unowned data directory still answers',
  strayOut.includes('"id":2'),
  strayOut.split('\n').filter(Boolean).length + ' frame(s)'
)
stray.kill()

mcp.close()
console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
