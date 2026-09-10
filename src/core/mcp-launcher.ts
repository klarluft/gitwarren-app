/**
 * Where the stable launchers live. One path per OS, on every machine.
 *
 * Split out of `main/mcp-launch.ts` - which still owns *writing* the MCP file
 * and everything Electron knows about where this install put its server -
 * because from M3 the path has a second reader: a `gitwarren serve` with no
 * Electron anywhere near it has to tell the Agent Access page the same command
 * the app would have told it. Two processes computing "one path per OS"
 * separately is exactly the drift the launcher exists to prevent, so the
 * computation is here, free of any `electron` import, and both import it.
 *
 * M3.3 put a second file in the same directory. `~/.gitwarren/bin/gitwarren` is
 * the CLI at a path that does not move: it is what a login item names, and what
 * M4 spawns over ssh as `~/.gitwarren/bin/gitwarren serve --stdio`. The
 * directory is shared on purpose - one place a user can look at, inspect and
 * delete, holding every generated file GitWarren asks another program to run.
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

/**
 * The CLI's own stable path, written by `gitwarren service install`.
 *
 * `.cmd` on Windows for the same reason the MCP launcher takes it: a file the
 * Task Scheduler and a user's own shell both have to be able to run has to be
 * something `cmd` recognises as executable, and an extensionless script is not.
 */
export function getCliLauncherPath(): string {
  return join(
    getLauncherDirectory(),
    process.platform === 'win32' ? 'gitwarren.cmd' : 'gitwarren'
  )
}
