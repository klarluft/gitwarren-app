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
 * ## The wait is shown, because the switch cannot show it
 *
 * The consequence of not being optimistic is that between the click and the
 * machine's answer the switch sits in its old position, and a switch that has
 * not moved is indistinguishable from a click that did not land. `tailscale
 * serve` is fast when the tailnet has certificates and slow when it has to
 * provision one, so the gap is real either way and the panel says what is
 * happening in it rather than leaving the user to guess. Same `Loader2` the
 * host dialogs use, for the same reason.
 *
 * ## The URL is a thing to use, not a thing to read
 *
 * It was prose - "Open it at <url>" - and prose is the one shape that serves
 * neither of the two things anybody does with it. The address is for *another*
 * device: a phone, the laptop in the other room. So the first affordance is
 * copy, because the trip it has to make is into a message or a password
 * manager, and a URL you cannot select is a URL you retype by hand off a
 * screen, `tail688c0c` and all.
 *
 * The second is the link itself, for the one question this machine can answer
 * on its own - whether the thing works at all. `target="_blank"` is what makes
 * that open the real browser rather than navigating the app window away from
 * the app: the main process catches it in `setWindowOpenHandler` and hands it
 * to `shell.openExternal`. In a browser tab it is simply a link, which is the
 * same reason `components/markdown.tsx` spells its anchors that way.
 *
 * ## Absent rather than disabled when there is no Tailscale
 *
 * Rule 3: Tailscale is discovery and identity, never a dependency. A machine
 * without it is an ordinary machine with one fewer option, not a machine with a
 * greyed-out switch implying it is missing something - which is the same
 * argument `ShellCapabilities` makes about a control that explains itself when
 * pressed.
 */
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { Globe, Loader2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/components/ui/card'
import { Breakable } from '@/components/breakable'
import { CopyButton } from '@/components/copy-button'
import { api, CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'

export function TailnetPanel() {
  const { data: tailnet, mutate } = useSWR(CACHE_KEYS.tailnet, () => api.hosts.tailnet())
  // Null when nothing is in flight; otherwise what was asked for, which is the
  // only thing the panel is entitled to claim before the machine answers.
  const [pending, setPending] = useState<boolean | null>(null)
  const busy = pending !== null
  const [failure, setFailure] = useState<string | null>(null)
  // The anchor below, so a refused clipboard can select it instead.
  const webRootRef = useRef<HTMLAnchorElement>(null)

  // Nothing until the first read lands, and nothing at all on a machine with no
  // Tailscale. A switch that appeared and then vanished would be worse than one
  // that arrived a moment late.
  if (!tailnet?.available) return null

  async function toggle(next: boolean): Promise<void> {
    setPending(next)
    setFailure(null)
    try {
      // No optimistic value, deliberately - see the header. `tailscale serve`
      // can take a second or two, and showing "on" during it would be showing
      // the request rather than the machine. The pending line below is how the
      // user knows the click landed without being told an outcome yet.
      await mutate(api.hosts.setTailnetExposure({ exposed: next }), { revalidate: false })
    } catch (error) {
      setFailure(errorMessage(error))
      void mutate()
    } finally {
      setPending(null)
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

      {busy ? (
        // Which direction, because "putting it on" and "taking it off" fail
        // differently and the user is waiting on one specific thing.
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          {pending ? 'Putting this machine on your tailnet…' : 'Taking it off your tailnet…'}
        </p>
      ) : null}

      {!busy && tailnet.exposed && tailnet.webRoot ? (
        <div className="flex items-center gap-1">
          {/* `Breakable` so it wraps at its separators and stays selectable at
              390 px - the rule M3.5 set and M4.5 found the hard edge of. The
              anchor is the same element the copy button selects when the
              clipboard is refused, which is why it holds the ref. */}
          <a
            ref={webRootRef}
            href={tailnet.webRoot}
            target="_blank"
            rel="noreferrer noopener"
            data-selectable
            className="min-w-0 flex-1 font-mono text-xs text-primary underline underline-offset-2 hover:no-underline"
          >
            <Breakable text={tailnet.webRoot} />
          </a>
          <CopyButton
            label="Copy this machine's tailnet address"
            text={tailnet.webRoot}
            source={webRootRef}
            className="shrink-0"
          />
        </div>
      ) : null}

      {failure ? <p className="text-xs text-destructive">{failure}</p> : null}
    </Card>
  )
}
