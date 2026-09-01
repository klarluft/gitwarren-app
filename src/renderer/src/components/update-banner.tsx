/**
 * The only visible surface of auto-update.
 *
 * Checking and downloading happen silently in the background; this appears
 * only once a version is staged, offering an immediate restart. Doing nothing
 * is also fine - the update applies on the next quit either way.
 */
import { useEffect, useState } from 'react'
import { Download, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { UpdateStatus } from '@shared/api'

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    void api.updates.getStatus().then(setStatus)
    return api.updates.subscribe(setStatus)
  }, [])

  if (status.state === 'ready') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm">
        <Download className="size-4 shrink-0 text-primary" />
        <p className="flex-1">
          Version <span className="font-medium">{status.version}</span> is ready to install.
        </p>
        <Button size="sm" onClick={() => void api.updates.installNow()}>
          <RotateCw />
          Restart now
        </Button>
      </div>
    )
  }

  if (status.state === 'downloading') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground">
        <Download className="size-4 shrink-0 animate-pulse" />
        <p className="flex-1">Downloading update… {status.percent}%</p>
      </div>
    )
  }

  // idle / checking / available / error / unsupported are all silent by design.
  return null
}
