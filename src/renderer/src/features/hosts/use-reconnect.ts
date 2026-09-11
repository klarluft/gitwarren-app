/**
 * The silent half of M4.5: what happens when the machine answers again.
 *
 * A banner is the visible half and the easy one. The part a person actually
 * notices is that the screen they left open comes back by itself when the
 * laptop wakes - without a refresh button, without a navigation, and without
 * their place in a diff being lost.
 *
 * Two things have to be true for that, and only one of them was.
 *
 * **Something has to keep asking.** That is the retry in `main.tsx`, because
 * SWR's own fifteen-second poll stops at the exact moment there is something to
 * notice - see the note there.
 *
 * **One read coming back has to bring the rest with it.** This file. A review
 * screen holds half a dozen keys - the review, the diff, the commits, each
 * expanded file - and most of them are `LIVE_READ_OPTIONS` reads that
 * deliberately never retry, because a diff is expensive and re-running it
 * behind someone's back is not a favour. So the one read that *is* retrying is
 * the whole machine's heartbeat: when it succeeds, everything scoped to that
 * machine is revalidated at once, and the screen redraws whole rather than in
 * pieces over the following minutes.
 *
 * Revalidating by key suffix is what makes that a single line, and it is not a
 * trick - `scoped()` in `lib/api.ts` puts the instance id on the end of every
 * key that names something a host owns, for the sake of the family-wide
 * `startsWith` invalidation at the front. Asking from the other end gives
 * "everything about that machine", which is the unit that just changed.
 *
 * The carrier's own reconnection is the same idea with a wider blast radius: a
 * tab that lost its socket lost every screen's freshness, this computer's
 * included, so everything is revalidated. It costs a handful of local SQLite
 * reads on a page that has just been offline.
 */
import { useEffect } from 'react'
import { useSWRConfig } from 'swr'
import { api, CACHE_KEYS } from '@/lib/api'
import { subscribeToHosts } from '@/lib/host-reachability'

export function useRefetchOnReconnect(): void {
  const { mutate } = useSWRConfig()

  useEffect(
    () =>
      subscribeToHosts((host, state) => {
        // Only the moment it comes back. The store announces a change of state
        // rather than every outcome, so this fires once per reconnection.
        if (state.offlineSince !== null) return
        void mutate(
          (key) =>
            typeof key === 'string' &&
            // The host list carries live reachability, so it is stale too - and
            // it is the one key about a machine that is deliberately not scoped
            // by one. See `CACHE_KEYS.hosts`.
            (key === CACHE_KEYS.hosts || key.endsWith(`@${host}`))
        )
      }),
    [mutate]
  )

  useEffect(
    () =>
      api.connection.subscribe((connected) => {
        if (connected) void mutate(() => true)
      }),
    [mutate]
  )
}
