/**
 * Where the stable MCP launcher lives. One path per OS, on every machine.
 *
 * Split out of `main/mcp-launch.ts` - which still owns *writing* the file and
 * everything Electron knows about where this install put its server - because
 * from M3 the path has a second reader: a `gitwarren serve` with no Electron
 * anywhere near it has to tell the Agent Access panel the same command the app
 * would have told it. Two processes computing "one path per OS" separately is
 * exactly the drift the launcher exists to prevent, so the computation is here,
 * free of any `electron` import, and both import it.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `~/.gitwarren/bin`. The same on Windows, where `~` is the user profile. */
export function getLauncherDirectory(): string {
  return join(homedir(), '.gitwarren', 'bin')
}

export function getMcpLauncherPath(): string {
  return join(
    getLauncherDirectory(),
    process.platform === 'win32' ? 'gitwarren-mcp.cmd' : 'gitwarren-mcp'
  )
}
