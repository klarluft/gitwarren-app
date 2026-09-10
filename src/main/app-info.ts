/**
 * What this install is, as one object.
 *
 * Lifted out of `ipc.ts` because since M3 it has two readers that must not
 * disagree: the window, over IPC, and a browser tab, over HTTP. The tab is
 * looking at the *same install* - same database, same instance id, same
 * launcher - so it has to be told the same thing, and the only way to guarantee
 * that is for there to be one place that says it.
 */
import { app } from 'electron'
import { getInstanceId } from '../core/instance.js'
import { getDataDirectory, getDatabasePath } from '../core/paths.js'
import { getLinkServerPort } from './link-server.js'
import { getMcpLaunchInfo } from './mcp-launch.js'
import type { AppInfo } from '../shared/api.js'

export function describeInstall(): AppInfo {
  return {
    version: app.getVersion(),
    instanceId: getInstanceId(),
    platform: process.platform,
    packaged: app.isPackaged,
    dataDirectory: getDataDirectory(),
    databasePath: getDatabasePath(),
    linkPort: getLinkServerPort(),
    mcp: getMcpLaunchInfo()
  }
}
