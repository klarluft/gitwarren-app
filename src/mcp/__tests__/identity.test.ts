/**
 * Coverage for turning an MCP handshake into an author.
 *
 * The point of the exercise is that the *same tool* always produces the *same
 * name*, without the agent being asked and without anything to trust. So the
 * assertions worth making are about the mapping being stable and total: known
 * clients get a proper name, unknown ones get a usable one rather than being
 * lumped together, and a client that sends nothing still ends up marked as a
 * machine.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agentAuthor, getSessionId, setSessionLabel, _forTests } from '../identity.js'
import { authorDisplayName } from '../../shared/actors.js'

const { displayNameFor } = _forTests

test('known clients get the name their users would recognise', () => {
  assert.equal(displayNameFor('claude-code'), 'Claude Code')
  assert.equal(displayNameFor('codex-cli'), 'Codex')
  assert.equal(displayNameFor('opencode'), 'opencode')
  assert.equal(displayNameFor('cline'), 'Cline')
})

test('the lookup is case-insensitive, because clients are not consistent', () => {
  assert.equal(displayNameFor('Claude-Code'), 'Claude Code')
  assert.equal(displayNameFor('CODEX'), 'Codex')
})

test('an unknown client is tidied up rather than discarded', () => {
  // The value still identifies that tool consistently, which is the property
  // that matters; only the presentation is guesswork.
  assert.equal(displayNameFor('some-new-agent'), 'Some New Agent')
  assert.equal(displayNameFor('my_agent.mcp'), 'My Agent')
  assert.equal(displayNameFor('IDE'), 'IDE')
})

test('a client that identifies as nothing is still marked as a machine', () => {
  assert.equal(displayNameFor(undefined), 'AI')
  assert.equal(displayNameFor('   '), 'AI')

  const author = agentAuthor(undefined)
  assert.equal(author.kind, 'agent')
  assert.equal(authorDisplayName(author), 'AI (AI)')
})

test('a client cannot take the name the UI reserves for the person', () => {
  const author = agentAuthor({ name: 'Human', version: '1.0.0' })
  assert.equal(author.kind, 'agent')
  assert.notEqual(author.name, 'Human')
  assert.equal(authorDisplayName(author), 'Human (client) (AI)')
})

test('every comment from one process carries the same session id', () => {
  const first = agentAuthor({ name: 'claude-code', version: '1.0.0' })
  const second = agentAuthor({ name: 'claude-code', version: '1.0.0' })

  assert.equal(first.session, second.session)
  assert.equal(first.session, getSessionId())
  assert.equal(first.session?.length, 8)
})

test('a session label is remembered until it is cleared', () => {
  setSessionLabel('auth-refactor')
  const labelled = agentAuthor({ name: 'claude-code', version: '1.0.0' })
  assert.equal(authorDisplayName(labelled), 'Claude Code · auth-refactor (AI)')

  setSessionLabel(null)
  assert.equal(authorDisplayName(agentAuthor({ name: 'claude-code', version: '1.0.0' })), 'Claude Code (AI)')
})
