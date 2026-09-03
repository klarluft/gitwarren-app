/**
 * How a separate process finds the running GUI.
 *
 * The MCP server is its own OS process. To hand an agent a clickable link back
 * into the app it has to know the port the GUI's loopback server picked, and
 * that port is chosen at runtime (port 0, so the OS assigns a free one) rather
 * than fixed - a fixed port is a collision waiting to happen on a developer's
 * machine, and the app is not important enough to win that fight.
 *
 * So the GUI writes it down and the MCP server reads it, in the data directory
 * both already agree on. Free of any `electron` import for the same reason
 * `paths.ts` is: both processes must land on the same file.
 *
 * The file is a *hint*, never a fact. A crash or a `kill -9` leaves it behind
 * pointing at a port nothing is listening on - or, worse, one that something
 * else has since been given. Hence the pid: a reader checks that the process
 * that wrote it is still alive before believing a word of it. Read it fresh on
 * every use, too. The MCP server commonly outlives several GUI launches, and a
 * port cached at startup would be wrong within the hour.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDataDirectory, getDataDirectory } from './paths.js'

const RUNTIME_FILE_NAME = 'gui-runtime.json'

export interface GuiRuntime {
  /** Loopback port of the GUI's static link server. */
  port: number
  /** The GUI's process id, used to tell a live file from a stale one. */
  pid: number
}

export function getGuiRuntimePath(): string {
  return join(getDataDirectory(), RUNTIME_FILE_NAME)
}

/**
 * Called by the GUI once its loopback server is listening.
 *
 * Logs rather than throws, like `clearGuiRuntime`. A machine that cannot write
 * this file loses deep links and nothing else, and taking the app down over a
 * convenience would be the wrong trade.
 */
export function writeGuiRuntime(runtime: GuiRuntime): void {
  try {
    ensureDataDirectory()
    writeFileSync(getGuiRuntimePath(), JSON.stringify(runtime), 'utf8')
  } catch (error) {
    console.error('[gui-runtime] could not publish the loopback port', error)
  }
}

/**
 * Called by the GUI on the way out. Missing is the same as gone.
 *
 * Never throws: this runs on `before-quit`, and a locked or read-only file is
 * not a reason to make quitting fail. A file left behind is handled anyway -
 * the pid check below is what makes staleness survivable.
 */
export function clearGuiRuntime(): void {
  try {
    rmSync(getGuiRuntimePath(), { force: true })
  } catch (error) {
    console.error('[gui-runtime] could not remove the runtime file', error)
  }
}

/** Whether the process that claims to be the GUI still exists. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. The pid may have been recycled onto an unrelated process, which
    // is survivable: the worst case is a link to a port that refuses the
    // connection, and the user sees the browser fail rather than the app open.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The running GUI, or null if there is not one.
 *
 * Null covers every failure equally - no file, unreadable file, JSON that is
 * not the shape promised, a dead pid - because a caller can do nothing useful
 * with the distinction. There is no link to offer, and that is the whole
 * answer.
 */
export function readLiveGuiRuntime(): GuiRuntime | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(getGuiRuntimePath(), 'utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const { port, pid } = parsed as Partial<GuiRuntime>

  if (!Number.isInteger(port) || !Number.isInteger(pid)) return null
  if (port === undefined || pid === undefined) return null
  if (port <= 0 || port > 65535 || pid <= 0) return null

  return isAlive(pid) ? { port, pid } : null
}
