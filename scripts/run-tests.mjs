/**
 * Test runner.
 *
 * Collects every *.test.ts under src/ and hands them to node:test through tsx.
 * Doing the globbing here rather than in the npm script keeps it working the
 * same way in zsh, bash and cmd.exe.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
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

const child = spawn(process.execPath, [tsxCli(), '--test', ...tests], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
