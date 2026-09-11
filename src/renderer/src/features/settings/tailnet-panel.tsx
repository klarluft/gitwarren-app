/**
 * The switch that puts this machine on its owner's tailnet.
 *
 * A panel of its own rather than a row on `settings-panel.tsx`, and the reason
 * is the same one that made that file a panel: the two answer different
 * questions. "When is GitWarren running" is about this computer's login items
 * and is absent in a browser tab, which has no OS to ask. "Is this machine
 * reachable by my other machines" is about the *core*, and is exactly as real
 * in a tab as in the window - more so, since the person running `gitwarren
 * serve` on a headless box is the one who most needs it.
 *
 * ## It says what the machine says, not what was asked for
 *
 * `tailscale serve` is machine state. It survives a GitWarren restart, and the
 * user can turn it off from a terminal without telling anybody - so the switch
 * shows what `core/tailnet.ts` read back, and a toggle is followed by another
 * read rather than by an optimistic value that sticks. The same instinct as the
 * login-item switch next door, for the same reason: a control that remembers
 * what it was told will eventually disagree with the machine, and the user has
 * no way to know which one is lying.
 *
 * That also covers the case M6.0 found. A tailnet without HTTPS certificates
 * leaves `tailscale serve --https` hanging rather than refusing, so asking for
 * exposure and *getting* it are genuinely different events, and the URL under
 * the switch is the one the machine reported - `http` or `https`, whichever
 * happened.
 *
 * ## Absent rather than disabled when there is no Tailscale
 *
 * Rule 3: Tailscale is discovery and identity, never a dependency. A machine
 * without it is an ordinary machine with one fewer option, not a machine with a
 * greyed-out switch implying it is missing something - which is the same
 * argument `ShellCapabilities` makes about a control that explains itself when
 * pressed.
 */
import { useState } from 'react'
import useSWR from 'swr'
import { Globe } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/components/ui/card'
import { Breakable } from '@/components/breakable'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'

export function TailnetPanel() {
  const { data: tailnet, mutate } = useSWR(CACHE_KEYS.tailnet, () => api.hosts.tailnet())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Nothing until the first read lands, and nothing at all on a machine with no
  // Tailscale. A switch that appeared and then vanished would be worse than one
  // that arrived a moment late.
  if (!tailnet?.available) return null

  async function toggle(next: boolean): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      // No optimistic value, deliberately - see the header. `tailscale serve`
      // can take a second or two, and showing "on" during it would be showing
      // the request rather than the machine.
      await mutate(api.hosts.setTailnetExposure({ exposed: next }), { revalidate: false })
    } catch (error) {
      setFailure(errorMessage(error))
      void mutate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <label htmlFor="tailnet-exposed" className="min-w-40 flex-1 cursor-pointer">
          <span className="block text-sm font-medium">Reachable on your tailnet</span>
          <span className="block text-xs text-muted-foreground">
            Your other machines can add this one as a host, and you can open its reviews in a
            browser on any device signed in as {tailnet.login}.
          </span>
        </label>
        <Switch
          id="tailnet-exposed"
          checked={tailnet.exposed}
          disabled={busy}
          onCheckedChange={(checked) => void toggle(checked)}
        />
      </div>

      {tailnet.exposed && tailnet.webRoot ? (
        // Shown rather than described, because it is the thing a person types
        // into a phone. `Breakable` so it wraps at its separators and stays
        // selectable at 390 px - the rule M3.5 set and M4.5 found the hard
        // edge of.
        <p className="text-xs text-muted-foreground">
          Open it at{' '}
          <span className="font-mono">
            <Breakable text={tailnet.webRoot} />
          </span>
        </p>
      ) : null}

      {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
    </Card>
  )
}
