/**
 * Main process entry: a tray app with one window, the IPC surface, and the
 * updater.
 *
 * "A tray app with one window" is M2's change, and it is a change of kind
 * rather than of degree. Before it, GitWarren was a program the user ran when
 * they wanted to look at a review; closing the window ended it, and an agent
 * that wrote a review while it was closed had nowhere to point. Now closing the
 * window puts it away, and the process stays: it holds the loopback port, so a
 * link handed out at any time works at any time, and it is the one owner of
 * this machine's reviews - see `core/daemon-runtime.ts`.
 *
 * The same binary also has two modes that are not a GUI at all. `--serve` runs
 * the headless daemon in this process, which is what a GitWarren on another
 * machine will spawn in M4; `--hidden` starts the tray without a window, which
 * is what a login item and an update relaunch use. Both are decided before
 * anything Electron-shaped happens, because the difference between them is
 * whether there is a window at all.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
// The same file electron-builder turns into the .icns/.ico; `?asset` copies it
// next to the bundle so it also exists at runtime. macOS takes its icon from
// the app bundle and ignores this, but a Linux window has no icon at all unless
// one is handed to BrowserWindow.
import icon from '../../build/icon.png?asset'
import { runDaemon } from '../daemon/daemon.js'
import { getDatabase, closeDatabase } from '../core/db/client.js'
import { clearDaemonRuntime, writeDaemonRuntime } from '../core/daemon-runtime.js'
import { getInstanceId } from '../core/instance.js'
import { getDatabasePath, getDataDirectory } from '../core/paths.js'
import { attachmentsService } from '../core/services/attachments.js'
import { hrefFor } from '../shared/routes.js'
import { registerAttachmentProtocol, registerAttachmentScheme } from './attachment-protocol.js'
import {
  receiveDeepLink,
  receiveDeepLinkFromArgv,
  registerDeepLinkClient,
  hasPendingRoute,
  setWindowFactory,
  takePendingRoute
} from './deep-link.js'
import { startForwardingEvents, stopForwardingEvents } from './events.js'
import { registerIpcHandlers } from './ipc.js'
import { startLinkServer, stopLinkServer } from './link-server.js'
import { wasOpenedAtLogin } from './login-item.js'
import { ensureMcpLauncher } from './mcp-launch.js'
import { isQuitting, markQuitting } from './quitting.js'
import { shouldStartHidden } from './start-hidden.js'
import { createTray, destroyTray } from './tray.js'
import { disposeUpdater, initialiseUpdater } from './updater.js'

const isDev = !app.isPackaged

// Before `app.whenReady()`: privileged scheme registration is only accepted
// this early. See `attachment-protocol.ts` for why the scheme exists at all.
registerAttachmentScheme()

/**
 * Opens the database, reporting failure to the user instead of crashing.
 * Returns false when the app should stop starting up.
 */
function openDatabaseOrReport(): boolean {
  try {
    getDatabase()
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[startup] could not open the database', error)
    dialog.showErrorBox(
      'GitWarren cannot open its database',
      `${detail}\n\n` +
        `Database file:\n${getDatabasePath()}\n\n` +
        `If an older or different version of GitWarren used this folder, it may have left ` +
        `an incompatible database behind. Moving or deleting the folder below lets GitWarren ` +
        `start again with a fresh one:\n${getDataDirectory()}`
    )
    app.quit()
    return false
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'GitWarren',
    ...(process.platform === 'darwin' ? {} : { icon }),
    backgroundColor: '#0b0b0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required for an ESM preload script. Context isolation is the control
      // that actually matters here, and it stays on.
      sandbox: false
    }
  })

  // Avoid the white flash before React has painted.
  window.once('ready-to-show', () => window.show())

  /**
   * Closing hides. This is the tray behaviour, and it is a `close` handler
   * rather than a `window-all-closed` one because a closed window is destroyed:
   * the next open would be a fresh process's worth of work - Chromium, the
   * renderer bundle, React, SWR's caches - and would land the user back on the
   * repository list rather than where they were. Hiding keeps all of it, so
   * reopening is instant and the review they were reading is still on screen.
   *
   * The cost is memory while it sits there, which is the trade every tray app
   * makes and the one the milestone is asking for.
   */
  window.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    window.hide()
  })

  // Anything that isn't the app itself opens in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A deep link that arrived before there was a window becomes this window's
  // starting location, so a cold start from a link paints the review itself
  // rather than the repository list and then a jump.
  const pending = takePendingRoute()
  const hash = pending ? hrefFor(pending) : undefined

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ?? ''))
  } else {
    const page = join(import.meta.dirname, '../renderer/index.html')
    void (hash ? window.loadFile(page, { hash }) : window.loadFile(page))
  }

  return window
}

/**
 * Bring GitWarren forward: the tray's Open, and the dock on macOS.
 *
 * Shows the existing window rather than making a new one whenever there is one,
 * which since M2 is almost always - the window is hidden, not gone.
 */
function openWindow(): void {
  const [existing] = BrowserWindow.getAllWindows()
  if (!existing) {
    createWindow()
    return
  }

  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
}

/**
 * `GitWarren --serve`: the daemon, in this process, instead of a GUI.
 *
 * The same `runDaemon` that `out/daemon/gitwarren.cjs` runs, so there is one
 * implementation rather than two that have to agree. What this mode is *for* is
 * a machine that has the app installed and is being reached from elsewhere -
 * M4 spawns exactly this over `ssh` when the far end turns out to have a full
 * GitWarren rather than only the daemon tarball.
 *
 * Everything a GUI does is skipped, and the single-instance lock most of all: a
 * daemon serving one pipe is not a second copy of the app and must not be
 * turned away by one that happens to be running. It claims no ownership and
 * writes no runtime file for the same reason - it holds no port, and the GUI
 * next to it is still the owner of this machine.
 *
 * Chromium is initialised anyway, since this is the Electron binary. That is
 * the price of the mode existing at all, and it is why the tarball from spike
 * S3 rather than this is the answer for a headless box.
 */
function runServeMode(): void {
  // Nothing may reach stdout but the protocol.
  app.dock?.hide()

  // `--stdio` explicitly, rather than forwarding argv. stdio is the only
  // carrier a daemon has in M2, so `--serve` means it; M3 adds `--listen`, and
  // that is the release where this grows an argv parser worth the name.
  if (!runDaemon(['--stdio'])) {
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {
    // There are none, and there never will be. Overriding the default keeps a
    // stray internal window from taking the daemon down with it.
  })
}

if (process.argv.includes('--serve')) {
  runServeMode()
} else if (!app.requestSingleInstanceLock()) {
  // A second instance would open a second window onto the same database. Hand
  // focus back to the running one instead. (The MCP server is exempt: it is a
  // different entry point and never calls requestSingleInstanceLock.)
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Since M2 the running instance may have no visible window at all, so this
    // opens rather than merely focuses. Someone who launched GitWarren again
    // wants to see GitWarren.
    openWindow()
    // Windows and Linux deliver a deep link by starting the app again with the
    // URL in argv; the single-instance lock turns that into this event.
    receiveDeepLinkFromArgv(argv)
  })

  // macOS delivers it as an event instead - and can do so before `whenReady`
  // resolves, when the click is what launched the app. Registered out here for
  // that reason: a listener attached inside `whenReady` would miss it.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receiveDeepLink(url)
  })

  registerDeepLinkClient()

  void app.whenReady().then(() => {
    // Opening the database here runs migrations before the UI can issue its
    // first query, and surfaces a broken install immediately rather than as a
    // failed fetch in the renderer.
    //
    // If that fails there is nothing worth showing a window for, but dying
    // silently would leave the user with an app that simply never appears - so
    // say what went wrong and where the file is before quitting.
    if (!openDatabaseOrReport()) return

    registerAttachmentProtocol()
    registerIpcHandlers()

    // Before the first window, so that a write which happens during startup -
    // an agent already running against this data directory - is not announced
    // into a silence. The forwarder reads the window list at delivery time, so
    // there is nothing here that depends on a window existing yet.
    startForwardingEvents()

    // Written before anything else needs it. An agent may be configured against
    // this path already and start the moment the user does, so the file should
    // be current before the window is even up.
    ensureMcpLauncher()

    // Started here rather than after the window so the port is claimed as early
    // as it can be. It arrives asynchronously, hence the callback - and the
    // port may be null, which is a real answer: something else holds 41427, and
    // the runtime file says so rather than pretending.
    startLinkServer((linkPort) =>
      writeDaemonRuntime({
        instanceId: getInstanceId(),
        pid: process.pid,
        linkPort,
        owner: 'gui'
      })
    )

    // Buffers the launch URL, if this start came from a link on Windows or
    // Linux, so that `createWindow` below opens straight onto it.
    receiveDeepLinkFromArgv(process.argv)

    // The tray comes up whether or not a window does. It is the only thing on
    // screen in a hidden start, and the only way to quit.
    const hasTray = createTray(openWindow)

    // A link beats a hidden start: someone clicked something, and the point of
    // clicking it was to see a review. Asked rather than taken - `createWindow`
    // is what consumes the route, and turns it into the window's first paint.
    //
    // And a missing tray beats it too. A hidden start on a desktop with no
    // system tray would leave the user with no window, no icon and no menu -
    // a running process reachable only through a task manager. Better to
    // disregard the request to stay out of the way than to be unreachable.
    const hidden = shouldStartHidden(process.argv, wasOpenedAtLogin())
    if (!hidden || hasPendingRoute() || !hasTray) createWindow()

    // Only now: a link buffered during startup belongs to the window above, not
    // to a second one opened alongside it. From here on a link that arrives
    // with no window opens one for itself.
    setWindowFactory(createWindow)

    initialiseUpdater()

    // Attachments no body refers to any more are collected here, and only here.
    // Deliberately not in the MCP server: that may be one of several concurrent
    // processes, and a sweep from one of them could delete an image the GUI has
    // just ingested for a comment the user has not submitted yet. Failure is
    // logged rather than surfaced - nothing the user did is waiting on it.
    void attachmentsService
      .sweep()
      .then(({ removed }) => {
        if (removed > 0) console.log(`[startup] swept ${removed} unreferenced attachment(s)`)
      })
      .catch((error: unknown) => console.error('[startup] attachment sweep failed', error))

    app.on('activate', () => openWindow())
  })

  app.on('window-all-closed', () => {
    // Nothing. Before M2 this quit the app everywhere but macOS; now the window
    // is hidden rather than closed, so this fires only if a window is destroyed
    // outright - and even then, staying alive is the point. The tray's Quit and
    // the platform's own quit are the ways out.
  })

  app.on('before-quit', () => {
    markQuitting()
    stopForwardingEvents()
    disposeUpdater()
    destroyTray()
    stopLinkServer()
    // Removed rather than left to the pid check, so that a reader is told "no
    // owner" immediately instead of after a syscall on a recycled pid.
    clearDaemonRuntime()
    closeDatabase()
  })
}
