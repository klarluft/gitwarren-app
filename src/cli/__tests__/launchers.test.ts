/**
 * The launcher scripts, which are the one file everything else points at.
 *
 * `writeLaunchers` touches the real `~/.gitwarren/bin`, so what is tested here
 * is the refusal that guards it and the shape of what it would write - through
 * the same quoting helpers, which are where the interesting mistakes are.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cmdQuote, shellQuote } from '../../core/shell-quote.js'
import { writeLaunchers } from '../launchers.js'

test('a source checkout is refused rather than half-installed', () => {
  // `node` cannot run a .ts file, so a login item built from a checkout would
  // be a file that starts nothing - and would look installed.
  assert.throws(
    () => writeLaunchers({ node: '/usr/bin/node', script: null, mcpServer: null, env: {} }),
    /source checkout/
  )
})

test('shellQuote escapes what a double-quoted sh string reads', () => {
  assert.equal(shellQuote('/opt/gitwarren/bin/node'), '"/opt/gitwarren/bin/node"')
  assert.equal(shellQuote('/opt/$HOME/x'), '"/opt/\\$HOME/x"')
  assert.equal(shellQuote('/opt/`id`/x'), '"/opt/\\`id\\`/x"')
  assert.equal(shellQuote('/opt/a"b'), '"/opt/a\\"b"')
  assert.equal(shellQuote('C:\\x'), '"C:\\\\x"')
})

test('cmdQuote refuses a quote rather than pretending to escape it', () => {
  // `cmd` has no escape character inside quotes. The character is illegal in a
  // Windows filename anyway, which is what makes refusing it safe.
  assert.equal(cmdQuote('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"')
  assert.throws(() => cmdQuote('C:\\a"b'), /cannot contain a quote/)
})
