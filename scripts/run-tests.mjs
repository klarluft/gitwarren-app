/**
 * Test runner.
 *
 * Collects every *.test.ts under src/ and hands them to node:test through tsx.
 * Doing the globbing here rather than in the npm script keeps it working the
 * same way in zsh, bash and cmd.exe.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

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

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsx', '--test', ...tests],
  { stdio: 'inherit' }
)
child.on('exit', (code) => process.exit(code ?? 1))
