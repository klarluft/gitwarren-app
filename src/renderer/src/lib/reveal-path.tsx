/**
 * Whether this machine can show somebody a file, and under what name.
 *
 * M4.3 hid "Show in file manager" for every remote host, and the reason was
 * exact rather than cautious: `/home/xfor/app` handed to a Mac's Finder opens a
 * window on nothing, or worse on an unrelated local folder that happens to
 * exist. The rule it established is the one kept here - a control that would do
 * something plausible to the wrong machine is absent rather than disabled.
 *
 * M5 does not re-open that. It observes that the condition M4.3 was really
 * testing is *"can this machine name that file in its own filesystem"*, and that
 * `host === undefined` was only ever a correct proxy for it while every remote
 * host was across a network. Windows serving a WSL distribution at
 * `\\wsl.localhost\<distro>\…` is the one arrangement where the answer is yes
 * for a machine that is not this one - so the proxy is replaced by the question.
 *
 * Both halves have to be true and neither is guessable from the other: the host
 * must be reached by `wsl.exe`, and the *core* must be running on Windows. The
 * second is `appInfo.platform` rather than anything about the browser, and in a
 * tab it does not matter which, because `capabilities.revealPath` is false there
 * and the button is gone before this is asked. That is also why this returns a
 * path rather than a boolean: the caller needs the name to hand to the shell,
 * and there is no second place where the translation could go wrong.
 */
import useSWR from 'swr'
import { api, CACHE_KEYS } from '@/lib/api'
import { useHost } from '@/lib/host-scope'
import { windowsPathForWsl } from '@shared/wsl'
import type { AppInfo } from '@shared/api'
import type { HostWithState } from '@shared/schemas'

/**
 * The path to hand `system.revealPath`, or null when this machine cannot show
 * it at all.
 *
 * Null while the host list is still loading, deliberately. An unanswered
 * question is not the alarming answer - the same mistake M4.3's banner made in
 * the other direction - and here the cost of waiting a frame is a button that
 * appears a moment late, while the cost of guessing is a file manager opened on
 * a path that means something else.
 */
export function useRevealPath(path: string): string | null {
  const host = useHost()
  // Both are cached and neither polls: the host list is fetched by the Hosts
  // screen anyway and `appInfo` is memoised for the life of the window, so a
  // repository card asking costs nothing after the first one.
  const { data: hosts } = useSWR<HostWithState[], unknown>(
    host === undefined ? null : CACHE_KEYS.hosts,
    () => api.hosts.list()
  )
  const { data: info } = useSWR<AppInfo, unknown>(
    host === undefined ? null : CACHE_KEYS.appInfo,
    () => api.system.appInfo()
  )

  // This machine's own file, which is what it has always been.
  if (host === undefined) return path

  if (hosts === undefined || info === undefined) return null
  const row = hosts.find((candidate) => candidate.instanceId === host)
  if (row === undefined || row.kind !== 'wsl') return null
  if (info.platform !== 'win32') return null

  return windowsPathForWsl(row.target, path)
}
