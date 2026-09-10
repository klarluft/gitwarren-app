/**
 * The settings that belong to the machine rather than to a review.
 *
 * One switch today. It has a panel of its own rather than a line in the Agent
 * Access card because the two answer different questions - "how does an agent
 * reach GitWarren" and "when is GitWarren running" - and because the second one
 * is where the next few settings will go.
 *
 * The value is read from the OS on every mount and written straight back to it;
 * there is no copy in the database. The user can turn this off in System
 * Settings or by deleting a `.desktop` file, and a switch showing a remembered
 * value would then be lying about their machine.
 */
import { useState } from 'react'
import useSWR from 'swr'
import { Power } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/components/ui/card'
import { api, CACHE_KEYS } from '@/lib/api'

/** What the switch actually does, per platform, in one line under the label. */
function description(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'GitWarren opens in the menu bar when you log in, with no window.'
    case 'win32':
      return 'GitWarren opens in the notification area when you sign in, with no window.'
    default:
      return 'GitWarren opens in the system tray when you log in, with no window.'
  }
}

export function SettingsPanel() {
  const { data: info } = useSWR(CACHE_KEYS.appInfo, () => api.system.appInfo())
  const { data: openAtLogin, mutate } = useSWR(CACHE_KEYS.openAtLogin, () =>
    api.system.getOpenAtLogin()
  )
  const [busy, setBusy] = useState(false)

  if (!info || openAtLogin === undefined) return null

  async function toggle(next: boolean): Promise<void> {
    setBusy(true)
    try {
      // The optimistic value is shown while the write happens, and is then
      // replaced by what the OS reports rather than by what was asked for - a
      // write that silently failed should leave the switch where it was.
      await mutate(api.system.setOpenAtLogin(next), { optimisticData: next, revalidate: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex items-center gap-3 p-4">
      <Power className="size-4 shrink-0 text-muted-foreground" />
      <label htmlFor="open-at-login" className="flex-1 cursor-pointer">
        <span className="block text-sm font-medium">Start GitWarren at login</span>
        <span className="block text-xs text-muted-foreground">{description(info.platform)}</span>
      </label>
      <Switch
        id="open-at-login"
        checked={openAtLogin}
        disabled={busy}
        onCheckedChange={(checked) => void toggle(checked)}
      />
    </Card>
  )
}
