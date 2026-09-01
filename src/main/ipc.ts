/**
 * IPC handlers.
 *
 * Every repository handler is a one-line delegation to `repositoriesService`.
 * That thinness is the point: validation, path resolution and error semantics
 * all live in the service, so the UI and the MCP server cannot disagree about
 * what a valid repository is. If you find yourself adding logic here, it almost
 * certainly belongs in the service instead.
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { repositoriesService } from '../core/services/repositories.js'
import { reviewsService } from '../core/services/reviews.js'
import { getDataDirectory, getDatabasePath } from '../core/paths.js'
import { AppError } from '../shared/errors.js'
import { IPC_CHANNELS, type AppInfo, type IpcResult } from '../shared/api.js'
import { getMcpLaunchInfo } from './mcp-launch.js'
import { checkForUpdates, getUpdateStatus, quitAndInstall } from './updater.js'

/**
 * Wraps a handler so thrown errors arrive in the renderer as structured data
 * rather than as Electron's flattened "Error invoking remote method" string.
 */
function handle<T>(channel: string, handler: (payload: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, payload: unknown): Promise<IpcResult<T>> => {
    try {
      return { ok: true, data: await handler(payload) }
    } catch (error) {
      const appError = AppError.from(error)
      if (appError.code === 'INTERNAL') {
        // Unexpected failures are worth seeing in the terminal; the domain
        // errors below are ordinary user-facing outcomes.
        console.error(`[ipc] ${channel} failed`, error)
      }
      return { ok: false, error: appError.toSerialized() }
    }
  })
}

export function registerIpcHandlers(): void {
  handle(IPC_CHANNELS.repositoriesList, () => repositoriesService.list())
  handle(IPC_CHANNELS.repositoriesGet, (input) => repositoriesService.get(input))
  handle(IPC_CHANNELS.repositoriesAdd, (input) => repositoriesService.add(input))
  handle(IPC_CHANNELS.repositoriesUpdate, (input) => repositoriesService.update(input))
  handle(IPC_CHANNELS.repositoriesRemove, (input) => repositoriesService.remove(input))
  handle(IPC_CHANNELS.repositoriesRefs, (input) => repositoriesService.refs(input))

  handle(IPC_CHANNELS.reviewsList, (input) => reviewsService.list(input))
  handle(IPC_CHANNELS.reviewsGet, (input) => reviewsService.get(input))
  handle(IPC_CHANNELS.reviewsCreate, (input) => reviewsService.create(input))
  handle(IPC_CHANNELS.reviewsUpdate, (input) => reviewsService.update(input))
  handle(IPC_CHANNELS.reviewsRemove, (input) => reviewsService.remove(input))
  handle(IPC_CHANNELS.reviewsCommits, (input) => reviewsService.commits(input))
  handle(IPC_CHANNELS.reviewsDiff, (input) => reviewsService.diff(input))

  handle(IPC_CHANNELS.systemPickDirectory, async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a git repository',
      buttonLabel: 'Add repository',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(IPC_CHANNELS.systemRevealPath, async (input) => {
    if (typeof input !== 'string' || !input) {
      throw new AppError('INVALID_INPUT', 'A path is required.')
    }
    const failure = await shell.openPath(input)
    if (failure) throw new AppError('PATH_NOT_FOUND', failure)
  })

  handle(IPC_CHANNELS.systemAppInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    dataDirectory: getDataDirectory(),
    databasePath: getDatabasePath(),
    mcp: getMcpLaunchInfo()
  }))

  handle(IPC_CHANNELS.updatesGetStatus, () => getUpdateStatus())
  handle(IPC_CHANNELS.updatesCheck, () => checkForUpdates({ userInitiated: true }))
  handle(IPC_CHANNELS.updatesInstallNow, () => quitAndInstall())
}
