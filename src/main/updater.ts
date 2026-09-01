/**
 * Silent background auto-update.
 *
 * The shape is: check on launch and every few hours, download in the
 * background without asking, and apply on the next restart. The user is never
 * interrupted - the only UI is a quiet "Restart to update" affordance once a
 * download has finished, plus the option to restart immediately.
 *
 * Per-platform notes live in the README; the important constraint is that this
 * only works for the NSIS (per-user), macOS zip and AppImage targets. A
 * .deb/.rpm build has no self-update path and reports itself unsupported.
 */
import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC_CHANNELS, type UpdateStatus } from '../shared/api.js'

// electron-updater is CommonJS, so the named export has to come off the default.
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { state: 'idle' }
let timer: NodeJS.Timeout | null = null

function setStatus(next: UpdateStatus): void {
  status = next
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.updatesChanged, next)
  }
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * Auto-update needs a real installed build with an embedded publish config.
 * In dev there is nothing to update, so the whole subsystem stays inert rather
 * than throwing "dev-app-update.yml not found" on every launch.
 */
function updatesSupported(): boolean {
  return app.isPackaged
}

export function initialiseUpdater(): void {
  if (!updatesSupported()) {
    setStatus({ state: 'unsupported', reason: 'Auto-update is disabled in development builds.' })
    return
  }

  // Download without prompting, then stage it for the next quit. Both are the
  // library defaults; they are set explicitly because they are the requirement.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (message: unknown) => console.info('[updater]', message),
    warn: (message: unknown) => console.warn('[updater]', message),
    error: (message: unknown) => console.error('[updater]', message),
    debug: () => {}
  }

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'idle' }))
  autoUpdater.on('update-available', (info) => setStatus({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (progress) =>
    setStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version: status.state === 'available' ? status.version : null
    })
  )
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (error) =>
    // A failed check is not worth disrupting the session over - the app keeps
    // working on the current version and tries again on the next interval.
    setStatus({ state: 'error', message: error?.message ?? 'Update check failed.' })
  )

  void checkForUpdates()
  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
  timer.unref?.()
}

export async function checkForUpdates({ userInitiated = false } = {}): Promise<UpdateStatus> {
  if (!updatesSupported()) return status
  // Once a build is staged, re-checking would only restart the same download.
  if (status.state === 'ready' && !userInitiated) return status

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setStatus({
      state: 'error',
      message: error instanceof Error ? error.message : 'Update check failed.'
    })
  }
  return status
}

export function quitAndInstall(): void {
  if (status.state !== 'ready') return
  // isSilent: true, isForceRunAfter: true - no installer UI, app comes back up.
  autoUpdater.quitAndInstall(true, true)
}

export function disposeUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
