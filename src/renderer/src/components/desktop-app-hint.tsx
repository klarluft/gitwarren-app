/**
 * "There is also a desktop app", said once, to the one reader it is news for.
 *
 * This page can be served three ways: by the app, by a `gitwarren serve`
 * somebody typed, and since M7 by `gitwarren mcp --serve`, because an agent's
 * plugin needed a page for the links it hands out. Only the third reader
 * arrived without choosing GitWarren: they installed a plugin, their agent
 * handed them a link, and this tab is the first they have seen of it. They
 * are the one person for whom "you could also install this" is information
 * rather than a nag, so they are the only one told. `servedFor` on `AppInfo`
 * is how the daemon says which case this is, and it is absent in the other
 * two.
 *
 * Dismissable, and remembered per browser through the same preference store
 * the file tree uses, because a line that comes back on every visit is the
 * nag this is trying not to be. The page lives for one agent session; the
 * preference outlives it.
 *
 * Module-scope `api` on purpose, the exception `connection-banner.tsx` spells
 * out: this asks about the shell the person is using, which no route changes.
 * In the Electron window it renders nothing, ever, because the app never sets
 * the field.
 */
import useSWR from 'swr'
import { Monitor, X } from 'lucide-react'
import { CACHE_KEYS, api } from '@/lib/api'
import { useStoredFlag } from '@/lib/preferences'

const DOWNLOAD_URL = 'https://gitwarren.com'

export function DesktopAppHint() {
  const { data } = useSWR(CACHE_KEYS.appInfo, () => api.system.appInfo())
  const [dismissed, setDismissed] = useStoredFlag('desktop-app-hint-dismissed', false)

  if (dismissed || data?.servedFor !== 'agent') return null

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-sm">
      <Monitor className="size-4 shrink-0 text-muted-foreground" />
      <p className="flex-1 text-muted-foreground">
        This is GitWarren in a browser tab, started by your agent&apos;s plugin. There is also a
        desktop app, which keeps running between sessions:{' '}
        <a
          href={DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-foreground underline underline-offset-2"
        >
          gitwarren.com
        </a>
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
