/**
 * Spike S2 from docs/across-hosts.md: is a `wsl.exe` stdio pipe clean enough to
 * carry the daemon protocol?
 *
 * Spawns `wsl.exe -d <distro> -- cat` the way the Windows app would spawn the
 * daemon (`windowsHide: true`, piped stdio), writes newline-delimited JSON at it
 * and checks that every byte comes back unchanged. Two measurements matter: the
 * round trip of a single small line, which is what every RPC call pays, and the
 * throughput of a few megabytes, which is what a large diff pays.
 *
 * Run on the PC, from PowerShell or cmd, with the distro that holds the code:
 *
 *   node scripts/spikes/s2-wsl-stdio.mjs --distro Ubuntu --mb 10
 *
 * On macOS or Linux `--command cat` runs the same test against a local `cat`,
 * which is only useful as a sanity check of the script itself.
 *
 * Pass: "all N lines identical" and a small-line round trip well under 10 ms.
 * Fail: any mismatch (look for CRLF or UTF-8 damage in the first differing
 * line), or a hang - which means the pipe is buffering rather than streaming.
 * On fail the plan's fallback is a localhost TCP port bound inside WSL.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}
const distro = args.get('--distro') ?? 'Ubuntu'
const megabytes = Number(args.get('--mb') ?? 10)
const command = args.get('--command')

const [bin, ...binArgs] = command ? [command] : ['wsl.exe', '-d', distro, '--', 'cat']
const child = spawn(bin, binArgs, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.on('error', (error) => {
  console.error(`could not start ${bin}: ${error.message}`)
  process.exit(2)
})

// Every line carries characters that a pipe with the wrong encoding or newline
// translation would damage: non-ASCII, an emoji outside the BMP, and an escaped
// CR/LF pair inside a JSON string.
function makeLine(index) {
  return JSON.stringify({
    id: index,
    method: 'reviews.diff',
    text: `zażółć gęślą jaźń 🐇 line\r\n${index}`,
    blob: randomBytes(96).toString('base64')
  })
}

const lines = createInterface({ input: child.stdout, crlfDelay: 0 })
const received = []
lines.on('line', (line) => received.push(line))

function once(line) {
  return new Promise((resolve) => {
    const started = performance.now()
    const expected = received.length + 1
    const onLine = () => {
      if (received.length >= expected) {
        lines.off('line', onLine)
        resolve(performance.now() - started)
      }
    }
    lines.on('line', onLine)
    child.stdin.write(line + '\n')
  })
}

// 1. Small-line round trips, one at a time: the cost of a single RPC call.
const trips = []
for (let index = 0; index < 20; index += 1) {
  trips.push(await once(makeLine(index)))
}
trips.sort((a, b) => a - b)
console.log(
  `small line round trip: median ${trips[10].toFixed(2)}ms, min ${trips[0].toFixed(2)}ms, max ${trips[19].toFixed(2)}ms`
)

// 2. Bulk throughput: one big write, then wait for everything to come back.
const sent = received.slice()
const perLine = makeLine(0).length + 1
const count = Math.ceil((megabytes * 1024 * 1024) / perLine)
const started = performance.now()
const bulk = []
for (let index = 20; index < 20 + count; index += 1) {
  const line = makeLine(index)
  bulk.push(line)
  sent.push(line)
}
child.stdin.write(bulk.join('\n') + '\n')
child.stdin.end()
await new Promise((resolve) => lines.on('close', resolve))
const seconds = (performance.now() - started) / 1000
console.log(`bulk: ${count} lines, ${megabytes} MB in ${seconds.toFixed(2)}s (${(megabytes / seconds).toFixed(1)} MB/s)`)

// 3. Byte-exact comparison.
let mismatch = -1
for (let index = 0; index < sent.length; index += 1) {
  if (received[index] !== sent[index]) {
    mismatch = index
    break
  }
}
if (received.length !== sent.length || mismatch !== -1) {
  const at = mismatch === -1 ? received.length : mismatch
  console.error(`FAIL: ${received.length}/${sent.length} lines back, first difference at line ${at}`)
  console.error(`  sent:     ${JSON.stringify(sent[at])}`)
  console.error(`  received: ${JSON.stringify(received[at])}`)
  process.exit(1)
}
console.log(`PASS: all ${sent.length} lines identical`)
