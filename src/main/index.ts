/**
 * Main process entry: one window, the IPC surface, and the updater.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
// The same file electron-builder turns into the .icns/.ico; `?asset` copies it
// next to the bundle so it also exists at runtime. macOS takes its icon from
// the app bundle and ignores this, but a Linux window has no icon at all unless
// one is handed to BrowserWindow.
import icon from '../../build/icon.png?asset'
import { getDatabase, closeDatabase } from '../core/db/client.js'
import { clearGuiRuntime, writeGuiRuntime } from '../core/gui-runtime.js'
import { getDatabasePath, getDataDirectory } from '../core/paths.js'
import { attachmentsService } from '../core/services/attachments.js'
import { hrefFor } from '../shared/routes.js'
import { registerAttachmentProtocol, registerAttachmentScheme } from './attachment-protocol.js'
import {
  receiveDeepLink,
  receiveDeepLinkFromArgv,
  registerDeepLinkClient,
  setWindowFactory,
  takePendingRoute
} from './deep-link.js'
import { registerIpcHandlers } from './ipc.js'
import { startLinkServer, stopLinkServer } from './link-server.js'
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

// A second instance would open a second window onto the same database. Hand
// focus back to the running one instead. (The MCP server is exempt: it is a
// different entry point and never calls requestSingleInstanceLock.)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
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

    // Started here rather than after the window so the port is published as
    // early as it can be - an agent asking for a link a second after launch
    // should get one. The port arrives asynchronously, hence the callback.
    startLinkServer((port) => writeGuiRuntime({ port, pid: process.pid }))

    // Buffers the launch URL, if this start came from a link on Windows or
    // Linux, so that `createWindow` below opens straight onto it.
    receiveDeepLinkFromArgv(process.argv)

    createWindow()

    // Only now: a link buffered during startup belongs to the window above, not
    // to a second one opened alongside it. From here on a link that arrives
    // with no window - macOS, where closing the last one does not quit - opens
    // one for itself.
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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeUpdater()
    stopLinkServer()
    // Removed rather than left to the pid check, so that a reader is told "no
    // GUI" immediately instead of after a syscall on a recycled pid.
    clearGuiRuntime()
    closeDatabase()
  })
}
