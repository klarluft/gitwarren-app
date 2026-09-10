/**
 * What comes out of `gitwarren agent-setup`, and down which pipe.
 *
 * The split matters more than the words: `gitwarren agent-setup | pbcopy` has
 * to put the sentence on the clipboard and nothing else, so the status line
 * about a missing launcher goes to stderr. That is the sort of thing that is
 * obvious while writing it and invisible afterwards, until someone pastes a
 * warning into an agent.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { getMcpLauncherPath } from '../../core/mcp-launcher.js'
import { agentConfigSnippets, agentSetupPrompt } from '../../shared/agent-setup.js'
import { runAgentSetup } from '../agent-setup.js'

const realLog = console.log
const realError = console.error

afterEach(() => {
  console.log = realLog
  console.error = realError
})

/** Run the command with both streams captured. */
function capture(argv: readonly string[]): { ok: boolean; out: string; err: string } {
  let out = ''
  let err = ''
  console.log = (line: string) => {
    out += `${line}\n`
  }
  console.error = (line: string) => {
    err += `${line}\n`
  }

  const ok = runAgentSetup(argv)
  return { ok, out, err }
}

test('stdout is the prompt and only the prompt', () => {
  const { ok, out } = capture([])

  assert.equal(ok, true)
  assert.equal(out.trim(), agentSetupPrompt({ command: getMcpLauncherPath() }))
})

test('a missing launcher is a line on stderr, not a failure', () => {
  const { ok, out, err } = capture([])

  // Whether the launcher exists depends on the machine running the test, so the
  // assertion is on the pairing rather than on either half: the note appears
  // exactly when the command it names would be the right thing to type, it says
  // so on stderr, and it never makes the command fail.
  assert.equal(ok, true)
  assert.ok(!out.includes('service install'))
  assert.equal(err.includes('service install'), err !== '')
})

test('--manual prints every by-hand format, verbatim', () => {
  const { ok, out } = capture(['--manual'])

  assert.equal(ok, true)
  // Compared against the snippets themselves rather than against a count of the
  // path: on Windows the TOML one doubles every backslash, and a test that
  // counted occurrences of the raw path would fail there for the one reason
  // that is correct.
  for (const snippet of agentConfigSnippets({ command: getMcpLauncherPath() })) {
    assert.ok(out.includes(snippet.text.trimEnd()), `${snippet.id} was not printed`)
    assert.ok(out.includes(snippet.label), `${snippet.id} was printed unlabelled`)
  }
})

test('an argument that is not a flag is refused rather than ignored', () => {
  const { ok, out } = capture(['install'])

  assert.equal(ok, false)
  assert.equal(out, '')
})

test('--help is an answer, not a mistake', () => {
  const { ok, out, err } = capture(['--help'])

  // Asking for usage and getting exit 2 with the usage on stderr is the shape
  // of a typo, and every other command here treats the two differently.
  assert.equal(ok, true)
  assert.ok(out.includes('gitwarren agent-setup'))
  assert.equal(err, '')
})
