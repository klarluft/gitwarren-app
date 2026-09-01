import type { GitWarrenApi } from '@shared/api'

declare global {
  interface Window {
    /** Exposed by the preload script. The renderer's only way out. */
    gitwarren: GitWarrenApi
  }
}

export {}
