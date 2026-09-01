/**
 * The renderer's view of the bridge, plus the SWR cache keys.
 *
 * Everything the UI can do goes through `window.gitwarren`, which the preload
 * script installed. There is no fetch client and no API base URL - see the
 * README on why this app talks over IPC rather than a local HTTP server.
 */
import type { GitWarrenApi } from '@shared/api'

if (typeof window.gitwarren === 'undefined') {
  throw new Error(
    'The GitWarren bridge is missing. This usually means the preload script failed to load.'
  )
}

export const api: GitWarrenApi = window.gitwarren

export const CACHE_KEYS = {
  repositories: 'repositories',
  appInfo: 'app-info'
} as const
