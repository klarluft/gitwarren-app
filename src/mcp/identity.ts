/**
 * Working out which agent is on the other end of the pipe.
 *
 * The obvious design - add an `author` parameter to every comment tool and ask
 * the agent to fill it in - does not survive contact with reality. The same
 * Claude Code install would introduce itself as "Claude", "claude", "Claude
 * Code" and "Claude (Opus)" across four sessions, because nothing anchors the
 * value, and a review thread with four names for one participant is worse than
 * one with none.
 *
 * So the name is not asked for. MCP already carries it: every client sends an
 * `clientInfo: { name, version }` block in the `initialize` handshake, before
 * any tool is called, and the SDK keeps it (`Server.getClientVersion()`). That
 * value is chosen by the *tool* rather than by the model driving it, which is
 * exactly the property needed - it is identical for every Claude Code session
 * on the machine, and different for Codex, opencode, Cline and the rest, with
 * no cooperation required from the agent and nothing to trust.
 *
 * Two further problems, and how far this goes on each:
 *
 *  - **Two sessions of the same tool.** stdio gives one server *process* per
 *    client session, so this process is the session. `SESSION_ID` below is
 *    minted once at startup and stamped on every comment, which keeps two
 *    concurrent Claude Code sessions distinguishable in the database even when
 *    neither says anything about itself.
 *
 *  - **Making that legible to a human.** A session id is not a name. An agent
 *    may set a short label for itself - `auth-refactor`, `perf-pass` - either
 *    once per call or, more usefully, once for the whole session, after which
 *    it is remembered here and applied to everything that session writes. This
 *    is the one piece that is self-reported, and it is the one piece where that
 *    is fine: it is a nickname for a session, not a claim about identity, and
 *    the tool name underneath it is still the handshake's.
 */
import type { Implementation } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { HUMAN_NAME, type CommentAuthor } from '../shared/actors.js'

/**
 * Display names for the clients worth spelling properly.
 *
 * Keys are matched against `clientInfo.name` lowercased. This is cosmetic only:
 * an unknown client is not rejected or lumped in with the rest, it just gets
 * its raw handshake name, which is already consistent across its own sessions.
 * That is the property that matters, and it holds for clients that were never
 * on this list.
 */
const CLIENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  'codex-cli': 'Codex',
  opencode: 'opencode',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  cursor: 'Cursor',
  'cursor-vscode': 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  goose: 'Goose',
  aider: 'Aider',
  continue: 'Continue',
  'gemini-cli': 'Gemini CLI',
  copilot: 'Copilot',
  'github-copilot': 'Copilot'
}

/**
 * What an unidentified client is called.
 *
 * Reached only by a client that sent no usable `clientInfo`, which in practice
 * means a hand-rolled script. Calling it "AI" rather than guessing keeps the
 * one guarantee the UI makes - a machine-written comment is always marked as
 * one - true even here.
 */
const UNKNOWN_AGENT_NAME = 'AI'

/**
 * This process, and therefore this agent session. Minted once at import.
 * Short because it is only ever a tiebreaker between two live sessions, never
 * an identifier anything looks up.
 */
const SESSION_ID = randomUUID().slice(0, 8)

/**
 * Turn a handshake name into something worth putting next to a comment.
 *
 * Unknown clients are cleaned up rather than passed through raw: package-style
 * names (`some-agent`, `some_agent.mcp`) become `Some Agent`, so a client that
 * is not in the table above still reads as a name in the thread.
 */
function displayNameFor(rawName: string | undefined): string {
  const trimmed = rawName?.trim()
  if (!trimmed) return UNKNOWN_AGENT_NAME

  const known = CLIENT_DISPLAY_NAMES[trimmed.toLowerCase()]
  if (known) return known

  const words = trimmed
    .replace(/\.(mcp|cli|app)$/i, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (words.length === 0) return UNKNOWN_AGENT_NAME

  return words
    .map((word) => (word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

/**
 * The label for this session, once an agent has set one.
 *
 * Seeded from the environment so it can also be pinned in the MCP server config
 * itself - useful when a user runs one agent per project and wants every
 * comment from it labelled without the agent having to remember.
 */
let sessionLabel: string | null = process.env.GITWARREN_AGENT_LABEL?.trim() || null

export function setSessionLabel(label: string | null): void {
  sessionLabel = label && label.length > 0 ? label : null
}

export function getSessionLabel(): string | null {
  return sessionLabel
}

export function getSessionId(): string {
  return SESSION_ID
}

/**
 * The author to stamp on anything this connection writes.
 *
 * `clientInfo` is only available after the handshake, which every tool call is
 * by definition after, so the lookup is done per call rather than cached - a
 * cached `undefined` from before `initialize` would be a name lost for the life
 * of the process.
 */
export function agentAuthor(clientInfo: Implementation | undefined): CommentAuthor {
  const name = displayNameFor(clientInfo?.name)
  return {
    kind: 'agent',
    // Guard against a client that identifies as the one name the UI reserves
    // for the person using the app. Cheap, and it keeps "Human" meaning one
    // thing everywhere.
    name: name === HUMAN_NAME ? `${HUMAN_NAME} (client)` : name,
    label: sessionLabel,
    session: SESSION_ID
  }
}

/** Exported for the tests; the table is data, and data is worth checking. */
export const _forTests = { displayNameFor, CLIENT_DISPLAY_NAMES, UNKNOWN_AGENT_NAME }
