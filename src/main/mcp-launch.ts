/**
 * Works out how an agent should launch this install's MCP server.
 *
 * The server is a plain script shipped inside the app, started with the app's
 * own Electron binary in Node mode. That matters because `better-sqlite3` is a
 * native addon: it must be loaded by a runtime whose ABI it was built for, and
 * it has to resolve out of the app's own unpacked `node_modules`. Using the
 * bundled binary satisfies both, and means the user needs no Node installation.
 */
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { join } from 'node:path'
import type { McpLaunchInfo } from '../shared/api.js'

export function getMcpLaunchInfo(): McpLaunchInfo {
  const scriptPath = app.isPackaged
    ? // asarUnpack keeps this file on the real filesystem so it can be spawned.
      join(process.resourcesPath, 'app.asar.unpacked', 'out', 'mcp', 'server.cjs')
    : join(app.getAppPath(), 'out', 'mcp', 'server.cjs')

  // An AppImage is mounted at a new /tmp/.mount_* directory on every launch, so
  // both the binary path and the script path below are only good for this run.
  // Extracting the AppImage once gives permanent paths.
  const appImage = process.env.APPIMAGE

  return {
    command: process.execPath,
    args: [scriptPath],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    available: existsSync(scriptPath),
    stable: !appImage,
    ...(appImage
      ? {
          note:
            'These paths point inside the running AppImage, which is re-mounted at a new ' +
            'location every launch. Extract it once with ' +
            `\`${appImage} --appimage-extract\` and use the paths under the resulting ` +
            '`squashfs-root/` directory instead.'
        }
      : {})
  }
}
