/**
 * What to hand an agent so it can reach this install, in one sentence and in
 * three config formats.
 *
 * The sentence is the point. An agent knows its own configuration format - the
 * file, the key, the syntax, the reload - better than any panel can, and it
 * knows it for harnesses that did not exist when this was written. What it
 * cannot know is the command, so that is all we tell it. `~/.gitwarren/bin/
 * gitwarren-mcp` is the same path on every machine and after every update
 * (`core/mcp-launcher.ts`), which is what makes a sentence enough.
 *
 * The per-harness snippets stay as the fallback, generated from that same
 * launcher path rather than written out per format, so there is exactly one
 * place a command can be wrong. They are not the lead: JSON copied into the
 * wrong file, with a trailing comma or under the wrong key, is the failure the
 * sentence exists to remove.
 *
 * ## Why this is in `shared`
 *
 * Three readers: the Agent Access page in the Electron window, the same page in
 * a browser tab, and `gitwarren agent-setup` on a host with no UI at all. A
 * prompt that differs between them is a prompt the user cannot check against
 * anything, so all three read it from here.
 *
 * Plain JS only. No Node, no Electron - this is compiled into a browser bundle.
 */
import type { McpLaunchInfo } from './api.js'

/** The name every harness registers the server under. */
export const MCP_SERVER_NAME = 'gitwarren'

/**
 * The sentence, written *to* the agent rather than about it.
 *
 * It names the command, says what protocol comes out of it, and asks for a call
 * afterwards - because an agent that writes a config file and stops will report
 * success from something it has never run. `agent_identity` is the cheapest
 * tool on the server and needs no arguments, which makes it the right one to
 * ask for.
 *
 * "no arguments, no environment" is in there because a harness that has seen a
 * dozen MCP servers will offer to add both, and every one it adds is a thing
 * that can drift from what the launcher already does for itself.
 */
export function agentSetupPrompt(mcp: Pick<McpLaunchInfo, 'command'>): string {
  return (
    `Set up the GitWarren MCP server for yourself. It speaks MCP over stdio and is started ` +
    `with the command ${mcp.command} (no arguments, no environment). Register it under ` +
    `the name "${MCP_SERVER_NAME}" in your own MCP configuration, then call its agent_identity ` +
    `tool to confirm it works.`
  )
}

/** One hand-configuration format, ready to paste. */
export interface AgentConfigSnippet {
  id: string
  /** The harnesses this exact text works in, listed so the reader can stop. */
  label: string
  /** Where it goes, in the words each harness uses for it. */
  hint: string
  /** For the syntax the snippet is written in - `json` or `toml`. */
  language: 'json' | 'toml'
  text: string
}

/**
 * A TOML basic string.
 *
 * Windows is the whole reason this function exists: a launcher path there is
 * `C:\Users\...\gitwarren-mcp.cmd`, and a backslash inside a TOML basic string
 * begins an escape. Pasting it raw produces either a parse error or - worse,
 * because `\U` is a real escape - a different path. The literal-string form
 * (`'...'`) would sidestep it, but Codex's own documentation writes commands in
 * basic strings and a snippet that looks unlike every other example is a
 * snippet people edit back into being wrong.
 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The same command, in each syntax a harness asks for it in.
 *
 * Three formats rather than one per product, because that is how many there
 * actually are: `mcpServers` is what Claude Code, Cursor, Windsurf and Gemini
 * CLI all read, VS Code renamed the object to `servers`, and Codex keeps its
 * whole configuration in TOML. A fourth harness will almost certainly be one of
 * these three again - which is the argument for the sentence above being the
 * lead and this being the disclosure underneath it.
 *
 * `args` and `env` are omitted rather than written as empty: the launcher takes
 * neither, and an empty array in a config file is an invitation to put
 * something in it. `direct` is not offered here either - it is a per-install
 * fallback the page shows on its own, not a format.
 */
export function agentConfigSnippets(mcp: Pick<McpLaunchInfo, 'command'>): AgentConfigSnippet[] {
  const server = { command: mcp.command }

  return [
    {
      id: 'mcp-servers',
      label: 'Claude Code, Cursor, Windsurf, Gemini CLI',
      hint: 'the `mcpServers` object in that harness\u2019 MCP config',
      language: 'json',
      text: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)
    },
    {
      id: 'vscode',
      label: 'VS Code',
      hint: '`.vscode/mcp.json`, or the user `mcp.json`',
      language: 'json',
      text: JSON.stringify({ servers: { [MCP_SERVER_NAME]: server } }, null, 2)
    },
    {
      id: 'codex',
      label: 'Codex',
      hint: '`~/.codex/config.toml`',
      language: 'toml',
      text: `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${tomlString(mcp.command)}\n`
    }
  ]
}
