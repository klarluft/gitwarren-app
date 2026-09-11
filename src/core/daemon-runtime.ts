/**
 * Which process owns this data directory right now, and how to reach it.
 *
 * This was `gui-runtime.json`, and it existed for one reason: the MCP server
 * needed the loopback port the GUI had just been handed, so the GUI wrote it
 * down. The port is fixed since M2 (`shared/link-port.ts`), so that reason is
 * gone - and what is left is the question the file turns out to have been
 * asking all along, which is *who owns this machine's reviews*.
 *
 * A data directory has at most one owner. Today that is the GUI whenever it is
 * running; from M3 it may instead be `gitwarren serve`, for someone who will
 * not install an Electron app; in M4 and M5 it is a daemon spawned over `ssh`
 * or `wsl.exe` by a GitWarren somewhere else. Exactly one of them writes this
 * file, and the second one to try is the one that steps aside.
 *
 * ## What the MCP server does with it, and what it does not
 *
 * Nothing about data. **The MCP server opens SQLite directly, always, whether
 * or not there is an owner** - which is a change from the plan and worth
 * stating plainly here, since this is the file the plan named.
 *
 * Rule 6 is why: agents never cross the network, so the MCP server is always on
 * the same machine as the database it is reading, and SQLite in WAL mode is
 * already the shared medium between two local processes - that is what
 * `db/client.ts` sets it up for. Routing an agent's reads through the owner
 * would buy nothing and cost the one property the milestone is verified on:
 * quit GitWarren completely, and the agent keeps working. A "talk to the owner"
 * path would have to fail back to SQLite the moment the window closed, which is
 * two code paths to keep in agreement in exchange for nothing.
 *
 * What does need the owner is a *push* - telling a running GUI that an agent
 * has just written a comment, so the window does not wait fifteen seconds to
 * find out. That needs a channel the MCP process may dial, and in M2 there is
 * not one: the link server is inert by design and answers nothing but a static
 * page, and the stdio carrier only serves a process that someone else spawned.
 * The WebSocket in M3 is that channel, and M6 is where the poke goes in.
 *
 * ## Still a hint, never a fact
 *
 * A crash or a `kill -9` leaves the file behind pointing at a pid that is gone,
 * or - worse - one the OS has since given to something else. So the pid is
 * checked before a word of it is believed, and it is read fresh on every use:
 * the MCP server routinely outlives several GUI launches, and anything cached
 * at startup would be wrong within the hour.
 *
 * Free of any `electron` import, for the same reason `paths.ts` is: the GUI,
 * the daemon and the MCP server are three processes that have to land on the
 * same file.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInstanceId } from '../shared/instance-id.js'
import { ensureDataDirectory, getDataDirectory } from './paths.js'

const RUNTIME_FILE_NAME = 'daemon-runtime.json'

/** The pre-M2 name, removed when it is found. Nothing reads it any more. */
const LEGACY_FILE_NAME = 'gui-runtime.json'

/**
 * What kind of process is holding the machine.
 *
 * Not cosmetic. A GUI has a window, a tray icon and a protocol handler, so a
 * link can be handed to it and it will raise itself; a daemon has none of those
 * and a link that reaches one has nowhere to go. Whoever asks needs to be able
 * to tell them apart, which is why this is a field rather than something
 * inferred from whether a port is present.
 */
export type RuntimeOwner = 'gui' | 'daemon'

export interface DaemonRuntime {
  /** This install's id - see `core/instance.ts`. */
  instanceId: string
  /** The owning process, used to tell a live file from a stale one. */
  pid: number
  /**
   * The loopback port actually being served, or null when the bind failed.
   *
   * Not where links point - links name `LINK_SERVER_PORT` whoever minted them,
   * because they are read on other machines and on other days. This says
   * whether anything is answering there now, which is what lets the Agent
   * Access panel warn instead of leaving the user to discover it in a browser.
   */
  linkPort: number | null
  owner: RuntimeOwner
  /**
   * Where this install's web view is on the tailnet, or null when it is not
   * exposed. `http://pc-wsl.tail688c0c.ts.net:41427/app/`, mount included.
   *
   * Published here for one reader: the MCP process, which is a separate process
   * and decides at call time whether a tool result carries a `webUrl`. It
   * cannot run `tailscale serve status` per call - that is a process spawn on
   * every comment - and it must not guess, because M6.0 found that a tailnet
   * may have no HTTPS and a URL assembled by convention would be one that does
   * not open.
   *
   * It belongs in *this* file rather than a new one because it is exactly what
   * this file is: a published fact about the machine, written with ordinary
   * permissions, read fresh and believed only after the pid check. The token,
   * by contrast, is a secret and stays next door at 0600 - `core/web/token.ts`
   * makes that distinction and it still holds.
   *
   * Null and absent mean the same thing, so a runtime file written by an older
   * install reads correctly rather than being discarded - which matters,
   * because discarding it would mean "no owner" and an MCP process that
   * silently stopped poking.
   */
  webRoot?: string | null
}

export function getDaemonRuntimePath(): string {
  return join(getDataDirectory(), RUNTIME_FILE_NAME)
}

/**
 * Claim the machine.
 *
 * Logs rather than throws, like `clearDaemonRuntime`. A machine that cannot
 * write this file loses a diagnostic and nothing else - links still work, since
 * they no longer depend on it - and taking the app down over that would be the
 * wrong trade.
 */
export function writeDaemonRuntime(runtime: DaemonRuntime): void {
  try {
    ensureDataDirectory()
    // The caller names the four fields it knows about; the tailnet URL is
    // carried across from whatever `writeDaemonExposure` last learned, so a
    // caller that has never heard of the tailnet cannot erase it by writing a
    // port. See `exposure` above on why the order is not fixed.
    const merged: DaemonRuntime = { ...runtime, webRoot: runtime.webRoot ?? exposure }
    published = merged
    writeFileSync(getDaemonRuntimePath(), JSON.stringify(merged), 'utf8')
    // Swept here rather than in a migration: this is the process that knows the
    // directory is now described by the file next to it.
    rmSync(join(getDataDirectory(), LEGACY_FILE_NAME), { force: true })
  } catch (error) {
    console.error('[runtime] could not publish the runtime file', error)
  }
}

/**
 * Release it. Missing is the same as gone.
 *
 * Never throws: this runs on the way out, and a locked or read-only file is not
 * a reason to make quitting fail. A file left behind is handled anyway - the
 * pid check below is what makes staleness survivable.
 */
export function clearDaemonRuntime(): void {
  published = null
  exposure = null
  try {
    rmSync(getDaemonRuntimePath(), { force: true })
  } catch (error) {
    console.error('[runtime] could not remove the runtime file', error)
  }
}

/**
 * What this process last published, so one field can be updated without the
 * caller having to remember the other four.
 *
 * Held in memory rather than read back off disk, because the writer is the
 * authority for its own row: re-reading would mean a second process's file
 * could be picked up and rewritten under this process's pid, which is exactly
 * the ownership confusion this file exists to prevent.
 */
let published: DaemonRuntime | null = null

/**
 * The last thing `writeDaemonExposure` was told, whether or not there was a
 * file to put it in yet.
 *
 * The two arrive in an order nothing controls. `tailscale serve status` is a
 * process spawn started as the shell comes up; the runtime file is written when
 * the port finishes binding. Either can land first, and the version where the
 * exposure lands first is the common one on a machine that was already exposed
 * - so the answer is not to sequence them but to let whichever is second merge
 * with what the first left. Held here rather than in `core/web/exposure.ts`
 * because this is the module that owns the file's contents.
 */
let exposure: string | null = null

/**
 * Update the tailnet URL in place, or record that there is not one.
 *
 * Safe before this process owns anything: the value is remembered and written
 * by the next `writeDaemonRuntime`. Safe when it never owns anything either - a
 * daemon spawned over a pipe never claims the directory, and writing a runtime
 * file from one would make it look like an owner.
 */
export function writeDaemonExposure(webRoot: string | null): void {
  exposure = webRoot
  if (!published) return
  if ((published.webRoot ?? null) === webRoot) return
  writeDaemonRuntime({ ...published, webRoot })
}

/** Whether the process that claims to own this directory still exists. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. The pid may have been recycled onto an unrelated process, which
    // is survivable: the worst case is a second owner standing aside for a
    // process that is not there, and the user starting it again.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The owner, or null if there is not one.
 *
 * Null covers every failure equally - no file, unreadable file, JSON that is
 * not the shape promised, a dead pid - because no caller can do anything useful
 * with the distinction. There is no owner, and that is the whole answer.
 */
export function readLiveDaemonRuntime(): DaemonRuntime | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(getDaemonRuntimePath(), 'utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const { instanceId, pid, linkPort, owner, webRoot } = parsed as Partial<DaemonRuntime>

  if (typeof instanceId !== 'string' || !isInstanceId(instanceId)) return null
  if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return null
  if (owner !== 'gui' && owner !== 'daemon') return null

  // Null is a value here, not an omission: it says the port is taken.
  const port =
    linkPort === null
      ? null
      : Number.isInteger(linkPort) && linkPort !== undefined && linkPort > 0 && linkPort <= 65535
        ? linkPort
        : undefined
  if (port === undefined) return null

  // Unknown or malformed is "not exposed" rather than a reason to reject the
  // whole file. The rest of it - which is what says who owns this machine and
  // where to poke them - is still perfectly good, and a GUI that stopped being
  // pokeable because a URL was the wrong shape would be a poor trade.
  const root = typeof webRoot === 'string' ? webRoot : null

  return isAlive(pid) ? { instanceId, pid, linkPort: port, owner, webRoot: root } : null
}
