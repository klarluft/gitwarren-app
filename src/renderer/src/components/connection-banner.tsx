/**
 * The other disconnection: this page has lost its own core.
 *
 * Deliberately not `features/hosts/host-banner.tsx`, and the separation is the
 * decision rather than a filing choice. A host that is asleep and a browser tab
 * whose socket has dropped look adjacent - both end with a stale screen - and
 * they are different in all three of the ways that matter.
 *
 * *Different evidence.* A machine that has gone away is learned from requests
 * that fail, which is all `lib/host-reachability.ts` reads. A dropped socket
 * fails nothing: `web/carrier.ts` queues whatever is asked while it is down, so
 * nothing settles, no error is thrown, and the outcome-based signal is blind to
 * it by construction. Only the socket knows, through `ShellConnection`.
 *
 * *Different reach.* A sleeping host makes that machine's screens stale. A
 * dropped socket makes every screen stale, this computer's included - the tab
 * is not talking to anything - so while it is down nothing can be claimed about
 * any host, and this sentence is the one that wins. Hence the order in
 * `App.tsx`: this above, and the host strip below it saying whatever it last
 * knew.
 *
 * *Different remedy.* A host has "Try again", because a person pressing it
 * knows something the backoff timer does not. There is no button here, and that
 * is honest rather than an omission: the carrier is already reconnecting on its
 * own timer, a reload would need the very server that is not answering, and the
 * one thing a person can usefully do - start GitWarren again on that machine -
 * is not something a page in a browser can offer to do for them.
 *
 * In the Electron window this renders nothing, ever. The window's carrier
 * reaches the main process of its own application, which cannot go away without
 * taking the window with it, so `connected()` is a constant `true` there and
 * the subscription is a no-op. One component, two shells, no branch on which.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Unplug } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * How long to let the carrier try before saying what a person can do.
 *
 * An ordinary blip - a sleeping laptop, a wifi handover - is back inside the
 * carrier's own ladder, which tops out at five seconds. Still down after this
 * long and the likely explanation is the other one, and it is the one a page
 * cannot fix for itself: `core/web/token.ts` mints its token per *launch* and
 * says why, so a GitWarren that has been restarted will refuse this tab's
 * session for ever, however patiently it reconnects. Verified in M4.5 by
 * stopping the app under an open tab - the socket retried against a 401 with
 * no end in sight, which is a spinner pretending to be progress.
 *
 * The sentence is deliberately conditional. This page cannot tell a restart
 * from a blip - both are a socket that will not open - and guessing wrong in
 * the confident direction would send somebody to re-open an app that is fine.
 */
const LIKELY_GONE_MS = 15_000

// Module scope on purpose, and it is the exception the M4.4 lesson allows: the
// two files that were caught importing the module-scope `api` were asking about
// a *machine*, where `useApi()` is the only correct reader. This asks about the
// shell the person is using, which no route can change.
const subscribe = (onChange: () => void): (() => void) =>
  api.connection.subscribe(() => onChange())

export function ConnectionBanner() {
  const connected = useSyncExternalStore(
    subscribe,
    () => api.connection.connected(),
    // Nothing renders this on a server, but `getServerSnapshot` is also what
    // React uses for hydration, and "connected" is the state that shows nothing.
    () => true
  )

  if (connected) return null
  return <Lost />
}

/**
 * Mounted only while the socket is down, and that is what resets the clock.
 *
 * The alternative - one component holding a timer and clearing it when the
 * connection comes back - has to remember to undo its own state on the way out,
 * which is a thing to forget. A component that only exists while the condition
 * does starts fresh every time by construction.
 */
function Lost() {
  const [awhile, setAwhile] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setAwhile(true), LIKELY_GONE_MS)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm"
    >
      <Unplug className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">GitWarren is not answering</p>
        <p className="text-muted-foreground">
          This page lost its connection and is trying to reconnect. What is on screen is what was
          loaded before, and nothing has been sent.
        </p>
        {awhile && (
          <p className="mt-1 text-muted-foreground">
            If GitWarren has been restarted since this page was opened, its link has expired and
            this page cannot get itself back. Open GitWarren again for a new one.
          </p>
        )}
      </div>
    </div>
  )
}
