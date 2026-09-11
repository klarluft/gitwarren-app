/**
 * The other end of M5's verify line: an agent *inside* the distribution.
 *
 * The point of a host owning its repositories is that the agent working next to
 * the code reads the review from the database next to the code, over a local
 * stdio MCP, with no network and no GitWarren in the middle. This drives that
 * MCP the way a harness does - `wsl.exe -d Ubuntu -e sh -c '~/.gitwarren/bin/
 * gitwarren-mcp'`, which is exactly the command `app.mcp` tells a person to
 * paste - and then checks that what the agent wrote shows up in the Windows
 * window.
 *
 * It is not Claude Code, and it is the surface Claude Code would use: the tools,
 * over stdio, answered by the distribution's own SQLite.
 *
 *   node scripts/verify/m5-agent.mjs [distro]
 */
import { spawn } from 'node:child_process'
import { Cdp } from '../cdp.mjs'

const distro = process.argv[2] ?? 'Ubuntu'
let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** An MCP session over the distribution's own launcher. */
function openMcp() {
  const child = spawn(
    'wsl.exe',
    ['-d', distro, '-e', 'sh', '-c', 'exec ~/.gitwarren/bin/gitwarren-mcp'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } }
  )
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
          // Not a frame. The server puts its banner on stderr, so this would be
          // something worth seeing - print it rather than swallow it.
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
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return { send, notify, close: () => child.kill() }
}

const mcp = openMcp()

console.log(`\n== an MCP session inside ${distro} ==`)
const init = await mcp.send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'm5-verify', version: '1' }
})
report('the distro answers an MCP handshake', init.result !== undefined,
  `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}`)
mcp.notify('notifications/initialized')

const tools = await mcp.send('tools/list')
const names = (tools.result?.tools ?? []).map((t) => t.name)
report('it offers its tools', names.length > 0, names.join(', '))

const call = async (name, args) => {
  const answer = await mcp.send('tools/call', { name, arguments: args })
  const text = (answer.result?.content ?? []).map((c) => c.text ?? '').join('\n')
  return { answer, text }
}

console.log('\n== what the agent can see ==')
const repos = await call('list_repositories', {})
report('the agent lists the distro\'s repositories', /\/home\/xfor/.test(repos.text),
  repos.text.split('\n').slice(0, 3).join(' | '))

const reviews = await call('list_reviews', {})
report('and its reviews', reviews.text.length > 0, reviews.text.split('\n').slice(0, 3).join(' | '))

// Find a review id to talk about.
const reviewId = Number(/(?:review\s*)?#?(\d+)/i.exec(reviews.text)?.[1] ?? 0)
report('a review to read', reviewId > 0, `review ${reviewId}`)

// `get_review` names its object `id`, like every method in this protocol.
const open = await call('get_review', { id: reviewId })
report('the agent reads the review from the database next to the code',
  !/error/i.test(open.text) && open.text.length > 0, open.text.split('\n').slice(0, 2).join(' | '))

console.log('\n== the agent writes, and the Windows window reads ==')
const marker = `M5 verification from inside WSL at ${new Date().toISOString()}`
const before = await call('list_review_comments', { reviewId })
report('the agent lists the existing discussion', !/error/i.test(before.text),
  `${before.text.length} characters`)

const wrote = await call('add_review_comment', { reviewId, body: marker })
// An MCP tool reports a refusal as *text*, not as a JSON-RPC error, so the
// absence of `answer.error` proves nothing on its own.
const failedToWrite = wrote.answer.error !== undefined || /MCP error|validation/i.test(wrote.text)
report('the agent left a comment on the review', !failedToWrite,
  failedToWrite ? wrote.text.slice(0, 200) : 'written into the distro\'s own database')

mcp.close()

if (!failedToWrite) {
  const cdp = await Cdp.attach(9222)
  const raw = await cdp.evaluate(`(async () => {
    const hosts = await window.gitwarren.carrier.request('hosts.list')
    const h = hosts.result.find((x) => x.kind === 'wsl')
    const o = await window.gitwarren.carrier.request('comments.list', { reviewId: ${reviewId} }, h.instanceId)
    return JSON.stringify(o)
  })()`)
  const outcome = JSON.parse(raw)
  const found = JSON.stringify(outcome.result ?? '').includes(marker.slice(0, 40))
  report('and the Windows app reads it back over the carrier', found,
    found ? 'the same comment' : JSON.stringify(outcome).slice(0, 200))
  cdp.close()
}

console.log(failures === 0 ? '\nALL OK\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
