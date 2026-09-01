/**
 * Main process entry: one window, the IPC surface, and the updater.
 */
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { getDatabase, closeDatabase } from '../core/db/client.js'
import { getDatabasePath, getDataDirectory } from '../core/paths.js'
import { registerIpcHandlers } from './ipc.js'
import { disposeUpdater, initialiseUpdater } from './updater.js'

const isDev = !app.isPackaged

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

    registerIpcHandlers()
    createWindow()
    initialiseUpdater()

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
