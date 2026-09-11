/**
 * The core's events, delivered to this app's windows.
 *
 * The Electron half of what `core/rpc/websocket.ts` does for a browser tab, and
 * it is four lines of work for the same reason the window's `ShellConnection`
 * is a constant `true`: the other end of this carrier is the main process of
 * the same application, so there is no socket to lose, no reconnect to survive
 * and nothing to queue. The bus is in this process; the window is in the next
 * one over.
 *
 * A module rather than a line in `main/index.ts` because the subscription has a
 * lifetime, and the one thing that could go wrong here is a leak: an event
 * emitted after quit began, into a `webContents` that is being torn down, is an
 * exception thrown from inside a database write. Hence the `isDestroyed` check
 * and `stopForwardingEvents`.
 *
 * Broadcast to every window, not to a focused one. Two windows on one machine
 * are two views of the same database, and a comment written in one is news in
 * both - which is also the first thing M6.1 is verified against, because it
 * needs no second machine.
 */
import { BrowserWindow } from 'electron'
import { subscribeToEvents } from '../core/events.js'
import { IPC_CHANNELS } from '../shared/api.js'

let unsubscribe: (() => void) | null = null

/**
 * Start forwarding. Idempotent, so a second call cannot double every event.
 *
 * Called once at startup rather than per window: `BrowserWindow.getAllWindows`
 * is read at delivery time, so a window opened later is included without
 * anything having to notice it was created. That is the same choice
 * `updater.ts` makes, and for the same reason - a per-window subscription would
 * need a matching teardown on every path a window can close by, including a
 * crash.
 */
export function startForwardingEvents(): void {
  if (unsubscribe) return

  unsubscribe = subscribeToEvents((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      // A window closing while a write is in flight is ordinary, and `send` on
      // a destroyed one throws. Checked rather than caught, because the throw
      // would surface as an `INTERNAL` from a method that actually succeeded.
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.rpcEvent, event)
    }
  })
}

/** Stop. Safe when it never started. */
export function stopForwardingEvents(): void {
  unsubscribe?.()
  unsubscribe = null
}
