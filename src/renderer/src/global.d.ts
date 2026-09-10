import type { GitWarrenBridge } from '@shared/api'

declare global {
  interface Window {
    /**
     * Exposed by the preload script. The renderer's only way out: a carrier
     * and the Electron shell. The API the screens use is built on top of it in
     * `lib/api.ts`.
     */
    gitwarren: GitWarrenBridge
  }
}

export {}
