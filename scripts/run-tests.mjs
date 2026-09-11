/**
 * Test runner.
 *
 * Collects every *.test.ts under src/ and hands them to node:test through tsx.
 * Doing the globbing here rather than in the npm script keeps it working the
 * same way in zsh, bash and cmd.exe.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function findTests(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findTests(path))
    else if (entry.name.endsWith('.test.ts')) found.push(path)
  }
  return found
}

const tests = findTests('src')
if (tests.length === 0) {
  console.error('No test files found under src/.')
  process.exit(1)
}

/**
 * tsx's CLI, to be run by this same Node rather than reached through `npx`.
 *
 * `npx` is a shell script on POSIX and `npx.cmd` on Windows, and since the fix
 * for CVE-2024-27980 Node refuses to spawn a `.cmd` at all unless `shell` is
 * set - it throws `EINVAL` before the command runs. So `npm test` had never
 * worked on Windows: naming `npx.cmd` there looks like the platform was handled
 * and stops one step short of it. CI only runs ubuntu, which is why nothing
 * said so.
 *
 * Handing the batch file to a shell would fix the spawn and buy a worse
 * problem, because `shell: true` concatenates rather than escapes: one test
 * file with a space in its path and the command line means something else.
 * Resolving the CLI and running it with `process.execPath` avoids the shell
 * altogether, and is the same code on every platform - which is the point, as
 * the branch is what went wrong here in the first place.
 *
 * Resolved through the package manifest rather than assumed to be at
 * `node_modules/tsx`, so it survives being hoisted somewhere else.
 */
function tsxCli() {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('tsx/package.json')
  return join(dirname(manifest), require(manifest).bin)
}

/**
 * The tests allowed to report themselves skipped, and the reason each one is.
 *
 * Four of these skip on every platform and the fifth skips on Windows, and
 * until now that asymmetry was invisible: `skipped 4` and `skipped 5` are the
 * same shape of line, so a test that quietly stopped running on one platform
 * looked exactly like the one that is *meant* not to run there. This list is
 * the difference. A skip whose name is on it is a decision somebody wrote
 * down; any other skip fails the run and is named.
 *
 * It is a set of names rather than a count per platform on purpose. Whether
 * the symlink test skips is a property of the machine and not of the operating
 * system - Windows allows an unprivileged process to create a symlink once
 * Developer Mode is on - so `win32 ? 5 : 4` would fail on a correctly
 * configured Windows box, which is the wrong machine to punish, and would have
 * had to be guessed at for the CI runner before anyone had watched one run.
 * "No test skips unless it is on this list" needs no platform branch and is
 * true everywhere.
 *
 * What it does not do is notice a test that stopped running by being deleted,
 * renamed out of `*.test.ts`, or never reached because the file it lives in
 * failed to load. Those are a different failure and this does not pretend to
 * cover them.
 */
const ENVELOPE = 'only a carrier holding raw messages can observe the response envelope'
const MAY_SKIP = new Map([
  [
    'a symlink counts as what it points at',
    'Windows refuses a symlink to an unprivileged process without Developer Mode (M5.0)'
  ],
  ['[over stdio, through the client] handleRequest returns the answer under the id it was asked with', ENVELOPE],
  ['[over stdio, through the client] handleRequest turns a failure into a message rather than a throw', ENVELOPE],
  [
    '[over stdio, through the client] field errors survive the trip, so a form can still put them under an input',
    ENVELOPE
  ],
  ['[over stdio, through the client] an unknown method comes back as a response too', ENVELOPE]
])

/**
 * A TAP report alongside the spec one that is the actual output.
 *
 * node:test writes both at once, so the terminal keeps the coloured spec run it
 * has always had and the file exists only to be read for `# SKIP` lines - which
 * carry the name of the test that skipped, the one thing the spec reporter's
 * `skipped 4` does not tell anybody.
 */
const tapDir = mkdtempSync(join(tmpdir(), 'gitwarren-tap-'))
const tapFile = join(tapDir, 'tests.tap')

const child = spawn(
  process.execPath,
  [
    tsxCli(),
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${tapFile}`,
    ...tests
  ],
  { stdio: 'inherit' }
)

child.on('exit', (code) => {
  let tap = ''
  try {
    tap = readFileSync(tapFile, 'utf8')
  } catch {
    // A run that never got as far as writing the file has nothing to say about
    // skips, and the exit code below is the more useful thing to report.
  }
  rmSync(tapDir, { recursive: true, force: true })

  // A failing suite already has the reader's attention. An unexpected skip
  // printed on top of it would only point away from the failure.
  if (code !== 0) process.exit(code ?? 1)

  const deliberate = []
  const unexpected = []
  for (const line of tap.split('\n')) {
    const name = /^\s*ok \d+ - (.*?) # SKIP(?: .*)?$/.exec(line)?.[1]
    if (name === undefined) continue
    if (MAY_SKIP.has(name)) deliberate.push(name)
    else unexpected.push(name)
  }

  // Printed on every platform, so that a Windows log and a Linux log differ
  // where they are supposed to differ and say why.
  if (deliberate.length > 0) {
    console.log(`\nNot checked on ${process.platform}, deliberately:`)
    for (const name of deliberate) console.log(`  - ${name}\n    ${MAY_SKIP.get(name)}`)
  }

  if (unexpected.length > 0) {
    console.error(`\n${unexpected.length} test(s) skipped without being listed in scripts/run-tests.mjs:`)
    for (const name of unexpected) console.error(`  - ${name}`)
    console.error(
      '\nA skip means this machine did not check that behaviour. If that is right,\n' +
        'add the name to MAY_SKIP with the reason, so the next person reading a\n' +
        'green run knows what it did not cover.'
    )
    process.exit(1)
  }

  process.exit(0)
})
