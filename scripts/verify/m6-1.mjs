/**
 * M6.1: a write in one shell reaching a screen in the other, live.
 *
 * The event channel's first slice needs no tailnet and no second machine - it
 * needs two *shells* on one core, which is the arrangement that already exists:
 * the Electron window talks to the main process over IPC, and a browser tab
 * talks to the same process over a WebSocket on the loopback port. A write that
 * arrives on one and is noticed on the other has crossed the whole channel.
 *
 * This script plays the part of the tab, with `ws` and the session token,
 * because a real second browser would add a browser to the things that could be
 * wrong. Everything it sends goes through the same upgrade, the same gate and
 * the same `serveWebSocket` a tab uses.
 *
 * Start the app first, in another terminal:
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-m6 \
 *     ./node_modules/.bin/electron . --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/gw-m6-chrome
 *
 * then: node scripts/verify/m6-1.mjs <a git repository path>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { Cdp, wait } from '../cdp.mjs'

const repositoryPath = process.argv[2]
if (!repositoryPath) {
  console.error('usage: node scripts/verify/m6-1.mjs <a git repository path>')
  process.exit(2)
}

const dataDirectory = process.env.GITWARREN_DATA_DIR
if (!dataDirectory) {
  console.error('GITWARREN_DATA_DIR must name the directory the app under test is using.')
  process.exit(2)
}

const PORT = 41427
const ORIGIN = `http://127.0.0.1:${PORT}`

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// The 0600 file `core/web/token.ts` publishes for `gitwarren open` to find. A
// process running as this user may read it; that is the whole of the gate on
// loopback, and the principal argument is in that module's header.
const token = readFileSync(join(dataDirectory, 'web-token'), 'utf8').trim()

console.log('\n== the tab half: a socket through the real gate ==')
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/gitwarren/socket`, {
  headers: { Origin: ORIGIN, Cookie: `gitwarren_session=${encodeURIComponent(token)}` }
})

/** Events this "tab" was pushed, in arrival order. */
const tabEvents = []
const pending = new Map()
let nextId = 1

await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
report('a socket with the session cookie is accepted', socket.readyState === WebSocket.OPEN)

socket.on('message', (data) => {
  const message = JSON.parse(String(data))
  // The discriminator both ends share. An event has no id; an answer does.
  if (typeof message.id !== 'number') {
    tabEvents.push({ ...message, at: Date.now() })
    return
  }
  pending.get(message.id)?.(message)
  pending.delete(message.id)
})

function ask(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (response) => {
      if (response.error) reject(new Error(`${response.error.code}: ${response.error.message}`))
      else resolve(response.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

console.log('\n== the window half: a spy on the carrier ==')
const cdp = await Cdp.attach(9222)
await cdp.evaluate(`(() => {
  window.__m6 = []
  window.__m6stop?.()
  window.__m6stop = window.gitwarren.carrier.onEvent((event) => {
    window.__m6.push({ ...event, at: Date.now() })
  })
  return true
})()`)
report('the window exposes an event subscription on its carrier', true)

const windowEvents = async () => JSON.parse(await cdp.evaluate('JSON.stringify(window.__m6)'))
const clear = async () => {
  tabEvents.length = 0
  await cdp.evaluate('(() => { window.__m6 = []; return true })()')
}

console.log('\n== a review to write on ==')
for (const existing of await ask('repositories.list', undefined)) {
  await ask('repositories.remove', { id: existing.id })
}
const repository = await ask('repositories.add', { path: repositoryPath })
const review = await ask('reviews.create', {
  repositoryId: repository.id,
  title: 'M6.1 — live updates',
  baseRef: 'HEAD',
  headRef: 'HEAD'
})
report('a review exists to comment on', Number.isInteger(review.id), `review ${review.id}`)

console.log('\n== a write in the tab, noticed in the window ==')
await clear()
const wroteAt = Date.now()
const thread = await ask('comments.createThread', {
  reviewId: review.id,
  body: 'Written over the socket, like a browser tab would.'
})
// Generous: what is being measured is "well under the fifteen-second poll", and
// a tighter bound would make this a timing test of an IPC hop rather than a
// test of the channel.
await wait(300)

const seenByWindow = await windowEvents()
const commentEvents = seenByWindow.filter((event) => event.event === 'comments.changed')
report(
  'the window heard about a comment it did not make',
  commentEvents.length === 1,
  `${seenByWindow.length} event(s): ${seenByWindow.map((e) => e.event).join(', ')}`
)
report(
  'it arrived in well under one poll interval',
  commentEvents.length === 1 && commentEvents[0].at - wroteAt < 1000,
  commentEvents.length === 1 ? `${commentEvents[0].at - wroteAt} ms` : 'no event'
)
report(
  'it carries a name and no content',
  commentEvents.length === 1 && commentEvents[0].data === null,
  commentEvents.length === 1 ? JSON.stringify(commentEvents[0]) : ''
)
report(
  'it is not tagged with a host: this core is the window’s own install',
  commentEvents.length === 1 && commentEvents[0].host === undefined
)

console.log('\n== and the other way: a write in the window, noticed in the tab ==')
await clear()
const fromWindow = await cdp.evaluate(`(async () => {
  const outcome = await window.gitwarren.carrier.request('comments.reply', {
    threadId: ${thread.id},
    body: 'Written in the window, like a person would.'
  })
  return JSON.stringify(outcome)
})()`)
report('the window’s write succeeded', !JSON.parse(fromWindow).error, fromWindow.slice(0, 120))
await wait(300)
report(
  'the tab heard about it on its own socket',
  tabEvents.filter((event) => event.event === 'comments.changed').length === 1,
  `${tabEvents.length} event(s): ${tabEvents.map((e) => e.event).join(', ')}`
)

console.log('\n== a read announces nothing ==')
await clear()
await ask('reviews.open', { id: review.id })
await ask('reviews.diff', { id: review.id, changes: 'all' })
await ask('repositories.list', undefined)
await wait(300)
report('three reads produced no events in the tab', tabEvents.length === 0,
  tabEvents.map((e) => e.event).join(', '))
report('and none in the window', (await windowEvents()).length === 0)

console.log('\n== and the screen itself redraws, which is the only part a person sees ==')
// Everything above proves the message arrives. This proves what it is *for*:
// `mutate` finding the key the conversation tab is subscribed to. It is the
// step that would still be missing if the scoping in `lib/event-scope.ts` were
// wrong, and nothing earlier in this script would have noticed.
await cdp.evaluate(
  `(() => { window.location.hash = '#/reviews/${review.id}/conversation'; return true })()`
)
await wait(1200)

const bodyText = () => cdp.evaluate('document.body.innerText')
const needle = 'Only a live update could have put this here'
const before = await bodyText()
report('the conversation tab is open and does not yet show the new comment',
  !before.includes(needle))

const paintedAt = Date.now()
await ask('comments.reply', { threadId: thread.id, body: needle })
// Well inside the fifteen-second poll and outside React's own scheduling.
await wait(600)
const after = await bodyText()
report(
  'a comment written elsewhere appears without anyone touching the window',
  after.includes(needle),
  `${Date.now() - paintedAt} ms after the write`
)

socket.close()
console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
