/**
 * Spike S5 from docs/across-hosts.md: how many IPC calls does each screen
 * make, and how many of them wait on each other?
 *
 * Drives a running app through its screens over CDP and, after each one,
 * prints the calls the main process logged since the last screen. The
 * `at` offsets show which calls started together and which waited for an
 * earlier one to finish - the sequential depth is what a network carrier
 * multiplies by its round trip.
 *
 * Seed a scratch database first (scripts/make-demo-repos.sh and
 * scripts/seed-demo.ts), then start the app with tracing on and stderr in a
 * file:
 *
 *   GITWARREN_TRACE_IPC=1 GITWARREN_DATA_DIR=/tmp/gw-demo \
 *     ./node_modules/.bin/electron . --remote-debugging-port=9222 2>/tmp/gw-ipc.log
 *   node scripts/spikes/s5-ipc-per-screen.mjs /tmp/gw-ipc.log 1
 *
 * The second argument is the review to open.
 */
import { readFileSync } from 'node:fs'
import { Cdp, settle, wait } from '../cdp.mjs'

const [log, reviewId = '1'] = process.argv.slice(2)
if (!log) {
  console.error('usage: node scripts/spikes/s5-ipc-per-screen.mjs <stderr log> [review id]')
  process.exit(2)
}
const cdp = await Cdp.attach(9222)

function calls() {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('[ipc]'))
}

async function screen(name, action) {
  const before = calls().length
  await action()
  await settle(cdp)
  // Long enough for every fetch a screen triggers, short enough to stay clear
  // of the 15-second comment poll.
  await wait(2500)
  const made = calls().slice(before)
  console.log(`\n## ${name}: ${made.length} calls`)
  for (const call of made) console.log('  ' + call.replace('[ipc] ', ''))
}

const go = (hash) => () => cdp.evaluate(`location.hash = ${JSON.stringify(hash)}`)

/**
 * Land on a screen with nothing cached, in exactly one mount.
 *
 * Setting the hash and then reloading looks equivalent and is not. The
 * hashchange lands first, React renders the screen, every read fires - and only
 * then does the reload tear the document down and do it all again. The log then
 * shows each key fetched twice, some 40 ms apart, which is a measurement of the
 * navigation helper rather than of the app. That artefact is what S5 recorded
 * as a "duplicated wave"; see the M1 note in docs/across-hosts.md.
 *
 * So the fragment travels with a real navigation: away to a blank document,
 * which throws the renderer's caches out, then straight to the target URL with
 * its hash already on it. One document, one mount, one wave.
 */
const reload = (hash) => async () => {
  const base = await cdp.evaluate("location.href.split('#')[0]")
  await cdp.send('Page.navigate', { url: 'about:blank' })
  await wait(250)
  await cdp.send('Page.navigate', { url: base + hash })
  await wait(1500)
}

await screen('home, cold load', reload('#/'))
await screen(`review ${reviewId}, conversation tab`, go(`#/reviews/${reviewId}/conversation`))
await screen(`review ${reviewId}, commits tab`, go(`#/reviews/${reviewId}/commits`))
await screen(`review ${reviewId}, files tab`, go(`#/reviews/${reviewId}/files`))
await screen('back to home', go('#/'))
await screen(`review ${reviewId}, files tab, cold load`, reload(`#/reviews/${reviewId}/files`))
process.exit(0)
