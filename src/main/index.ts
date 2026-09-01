/**
 * Main process entry: one window, the IPC surface, and the updater.
 */
import { app, BrowserWindow, dialog, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDatabase, closeDatabase } from '../core/db/client.js'
import { getDatabasePath, getDataDirectory } from '../core/paths.js'
import { ATTACHMENT_FILE_NAME, attachmentsService } from '../core/services/attachments.js'
import { registerIpcHandlers } from './ipc.js'
import { disposeUpdater, initialiseUpdater } from './updater.js'

const isDev = !app.isPackaged

/**
 * The `gitwarren:` scheme, registered before the app is ready because that is
 * the only point at which a scheme can be given privileges.
 *
 * `standard` gives it an origin, which is what makes it usable as an `<img>`
 * source; `secure` keeps it out of the mixed-content rules; `stream` lets a
 * large image arrive in pieces rather than being buffered whole.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'gitwarren', privileges: { standard: true, secure: true, stream: true } }
])

/**
 * Serve attachment images to the renderer.
 *
 * A plain `file://` src cannot do this job. Chromium refuses `file://`
 * subresources from a page on another origin, and the renderer's own origin
 * differs between environments - `http://localhost` under `electron-vite dev`,
 * `file://` in a packaged build. A custom scheme is identical in both, so the
 * markdown that renders an image in development renders it in production.
 */
function registerAttachmentProtocol(): void {
  protocol.handle('gitwarren', (request) => {
    const { host, pathname } = new URL(request.url)
    if (host !== 'attachment') return new Response(null, { status: 404 })

    const name = pathname.slice(1)
    // Comment bodies are agent-writable, so this URL is reachable by anything
    // an agent can put in a body. The test is the security boundary that stops
    // gitwarren://attachment/../../../../etc/passwd from being served: a sha
    // and a short extension is the whole vocabulary of a legitimate name, so
    // anything else is refused outright rather than resolved and then checked.
    if (!ATTACHMENT_FILE_NAME.test(name)) return new Response(null, { status: 400 })

    const file = join(getDataDirectory(), 'attachments', name.slice(0, 2), name)
    return net.fetch(pathToFileURL(file).toString())
  })
}

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

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return window
}

// A second instance would open a second window onto the same database. Hand
// focus back to the running one instead. (The MCP server is exempt: it is a
// different entry point and never calls requestSingleInstanceLock.)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

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
    createWindow()
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
    closeDatabase()
  })
}
