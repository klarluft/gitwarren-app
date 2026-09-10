/**
 * The port the link server listens on. One number, three processes.
 *
 * It is fixed rather than assigned by the OS, and that is a reversal of what
 * `core/gui-runtime.ts` used to do for a reason worth writing down.
 *
 * A loopback link used to be minted from a port the GUI had just been given, so
 * it could only exist while the GUI was up, and the MCP server had to read a
 * file to learn it. Both of those stop working the moment there is more than
 * one machine. A link written on the Mac is read on the PC; a link left in a
 * comment on Tuesday is clicked on Thursday. Neither may depend on which port
 * some process happened to win, so the port has to be the same number on every
 * install of GitWarren that has ever existed - which means choosing one and
 * defending it.
 *
 * 41427 is that number, from spike S6 in docs/across-hosts.md. It is outside
 * every default ephemeral range (49152-65535 on Windows and macOS, 32768-60999
 * on Linux), absent from `/etc/services`, unclaimed by anything well known, and
 * - the check that is easy to forget - not on Chromium's restricted-port list,
 * which would make a browser refuse to open the link at all.
 *
 * When something else holds it, the app starts anyway and links are still
 * emitted. They are the same on every machine, so a link printed on another
 * host must not depend on this one's luck; what the user gets is a warning in
 * the Agent Access page naming the port, not a different link.
 *
 * No Node, no Electron: the renderer, the main process, the daemon and the MCP
 * server all read this, for the same reason `routes.ts` is written the way it
 * is.
 */
export const LINK_SERVER_PORT = 41427

/** Loopback only. Never a hostname, and never an interface but this one. */
export const LINK_SERVER_HOST = '127.0.0.1'

export function linkServerOrigin(): string {
  return `http://${LINK_SERVER_HOST}:${LINK_SERVER_PORT}`
}
