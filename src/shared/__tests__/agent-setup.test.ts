/**
 * Coverage for the one string a user is asked to paste into another program.
 *
 * Nothing inside GitWarren consumes any of this: the prompt is read by an agent
 * we do not control and the snippets are read by a config parser in someone
 * else's process, so there is no integration test that can fail if a word goes
 * wrong. What is checkable is that the command reaches all four outputs
 * unaltered, and that the TOML stays TOML on a machine whose paths are made of
 * backslashes - which is the failure this file mainly exists to hold shut.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentConfigSnippets, agentSetupPrompt, MCP_SERVER_NAME } from '../agent-setup.js'

const POSIX = '/Users/xfor/.gitwarren/bin/gitwarren-mcp'
const WINDOWS = 'C:\\Users\\xfor\\.gitwarren\\bin\\gitwarren-mcp.cmd'

test('the prompt names the command, the server name and the tool to call', () => {
  const prompt = agentSetupPrompt({ command: POSIX })

  assert.ok(prompt.includes(POSIX))
  assert.ok(prompt.includes(`"${MCP_SERVER_NAME}"`))
  // The check afterwards is what stops an agent reporting success from a config
  // file it has never run.
  assert.ok(prompt.includes('agent_identity'))
  // One paragraph, no newlines: it is pasted into a chat box, and a blank line
  // in some of them sends the message halfway through.
  assert.ok(!prompt.includes('\n'))
})

test('every snippet carries the launcher path and nothing else to configure', () => {
  for (const snippet of agentConfigSnippets({ command: POSIX })) {
    assert.ok(snippet.text.includes(POSIX), `${snippet.id} lost the command`)
    // `args` and `env` are omitted rather than written empty - an empty array in
    // a config file is an invitation to put something in it.
    assert.ok(!snippet.text.includes('args'), `${snippet.id} offered args`)
    assert.ok(!snippet.text.includes('env'), `${snippet.id} offered env`)
  }
})

test('the JSON snippets parse, under the key each family reads', () => {
  const snippets = agentConfigSnippets({ command: WINDOWS })
  const parse = (id: string): unknown =>
    JSON.parse(snippets.find((snippet) => snippet.id === id)?.text ?? '') as unknown

  assert.deepEqual(parse('mcp-servers'), { mcpServers: { gitwarren: { command: WINDOWS } } })
  // VS Code renamed the object and nothing else about it.
  assert.deepEqual(parse('vscode'), { servers: { gitwarren: { command: WINDOWS } } })
})

test('a Windows path survives being written into TOML', () => {
  const codex = agentConfigSnippets({ command: WINDOWS }).find(
    (snippet) => snippet.id === 'codex'
  )

  assert.equal(codex?.language, 'toml')
  // Every backslash doubled: raw, `\U` is a real TOML escape and this parses as
  // a *different path* rather than as an error, which is the worse of the two.
  assert.equal(
    codex?.text,
    '[mcp_servers.gitwarren]\ncommand = "C:\\\\Users\\\\xfor\\\\.gitwarren\\\\bin\\\\gitwarren-mcp.cmd"\n'
  )
  assert.ok(!/[^\\]\\[^\\]/.test(codex?.text ?? ''), 'a lone backslash escaped something')
})
