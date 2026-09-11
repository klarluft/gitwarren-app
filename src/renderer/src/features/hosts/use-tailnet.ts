/**
 * This machine's tailnet reachability, read once for the three things that
 * want it.
 *
 * The switch on the Hosts screen needs it to draw itself, the section headings
 * around that switch need it to know whether there is a section at all, and the
 * Hosts card on the home screen needs it for its subtitle. One SWR key rather
 * than three reads: `hosts.tailnet` shells out to `tailscale`, and three
 * components asking separately would be three process spawns to render one
 * screen.
 *
 * A hook rather than each component calling `useSWR` with the same key is
 * mostly about the key. SWR would dedupe them anyway; what it would not do is
 * stop the fourth caller from spelling the fetcher slightly differently.
 */
import useSWR, { type SWRResponse } from 'swr'
import { api, CACHE_KEYS } from '@/lib/api'
import type { TailnetExposure } from '@shared/schemas'

export function useTailnet(): SWRResponse<TailnetExposure> {
  return useSWR(CACHE_KEYS.tailnet, () => api.hosts.tailnet())
}
