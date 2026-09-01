/**
 * Who wrote a comment.
 *
 * GitWarren has no accounts and no auth - it is one person's app on one machine
 * (see the note at the top of `mcp/server.ts`). An "author" here is therefore
 * not an identity to be *verified* but a description of where a message came
 * from, and the two answers that matter are "the person at the keyboard" and
 * "an agent, and which one".
 *
 * Neither answer is ever taken from the message itself. A comment arriving over
 * IPC is a human by construction, because the only way to send one is to type
 * it into the app. A comment arriving over MCP is an agent by construction, and
 * its name comes from the `clientInfo` block of the MCP handshake rather than
 * from anything the agent says at call time - see `mcp/identity.ts`. That is
 * what keeps two different Claude Code sessions from introducing themselves as
 * "Claude", "claude-code" and "Claude Opus" on three consecutive days.
 */

export type ActorKind = 'human' | 'agent'

/** What the UI calls the person using it. There is only ever one. */
export const HUMAN_NAME = 'Human'

/** The suffix that marks a comment as machine-written, wherever it is shown. */
export const AGENT_SUFFIX = 'AI'

export interface CommentAuthor {
  kind: ActorKind
  /** "Human", or the agent's tool name: "Claude Code", "Codex", "opencode". */
  name: string
  /**
   * An optional handle an agent chose for itself, to tell two of its own
   * concurrent sessions apart. Null for humans and for agents that did not set
   * one.
   */
  label: string | null
  /**
   * Opaque per-session id, assigned by the MCP server process rather than by
   * the agent. This is the fallback that keeps two unlabelled sessions of the
   * same tool distinguishable. Null for humans.
   */
  session: string | null
}

/**
 * The person using the app. Constructed by the IPC layer for every write that
 * arrives from the renderer, and by nothing else.
 */
export const HUMAN_AUTHOR: CommentAuthor = {
  kind: 'human',
  name: HUMAN_NAME,
  label: null,
  session: null
}

/**
 * The label shown next to a comment.
 *
 * `Human`, `Claude Code (AI)`, or `Claude Code · auth-refactor (AI)` once an
 * agent has named its session. The `(AI)` suffix is never omitted: knowing at a
 * glance which review feedback came from a machine is the point of tracking any
 * of this.
 */
export function authorDisplayName(author: CommentAuthor): string {
  if (author.kind === 'human') return author.name
  const named = author.label ? `${author.name} · ${author.label}` : author.name
  return `${named} (${AGENT_SUFFIX})`
}

/**
 * A short, stable key for one author, for grouping and for picking an avatar
 * colour. Sessions of the same tool share a name but not a key, so two agents
 * working the same review do not end up looking like one.
 */
export function authorKey(author: CommentAuthor): string {
  if (author.kind === 'human') return 'human'
  return `agent:${author.name}:${author.label ?? author.session ?? ''}`
}

/** Two-character monogram for the avatar. */
export function authorInitials(author: CommentAuthor): string {
  const source = author.kind === 'human' ? author.name : (author.label ?? author.name)
  const [first, second] = source.split(/[\s·_-]+/).filter(Boolean)
  if (!first) return '??'
  if (!second) return first.slice(0, 2).toUpperCase()
  return (first.charAt(0) + second.charAt(0)).toUpperCase()
}
