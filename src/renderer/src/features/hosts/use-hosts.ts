/**
 * Data access for the Hosts screen.
 *
 * Same bargain as `use-repositories.ts` - SWR owns the cache, every mutation
 * revalidates one key rather than patching rows by hand - with one difference
 * that comes from what a host row is. Half of it is stored (label, target, the
 * instance id once it is known) and half of it is read live from the connection
 * pool at the moment of asking. Patching a returned row into the list would
 * freeze that half at the instant the mutation answered, and a list where one
 * row's "reachable" is four seconds older than its neighbour's is worse than a
 * list that is uniformly a moment stale.
 *
 * There is deliberately no polling here. `repositories` re-reads git state on
 * an interval because that costs a `git status` on the local disk; a host list
 * that refreshed itself would be asking the pool, and the pool answering
 * honestly means connecting - so a screen left open on a second monitor would
 * hold an ssh connection to every machine in the list for as long as it was
 * open. Reachability is refreshed when the person asks: "Try now", the refresh
 * button, or arriving on the screen.
 */
import useSWR, { useSWRConfig } from 'swr'
import { useCallback } from 'react'
import { api, CACHE_KEYS } from '@/lib/api'
import type {
  AddHostInput,
  HostWithState,
  InstallReport,
  UpdateHostInput,
  WslDistro
} from '@shared/schemas'

export interface UseHostsResult {
  hosts: HostWithState[] | undefined
  error: unknown
  isLoading: boolean
  /** True during a background refresh, when stale rows are still on screen. */
  isRefreshing: boolean
  refresh: () => Promise<unknown>
}

export function useHosts(): UseHostsResult {
  const { data, error, isLoading, isValidating, mutate } = useSWR<HostWithState[], unknown>(
    CACHE_KEYS.hosts,
    () => api.hosts.list()
  )

  return {
    hosts: data,
    error,
    isLoading,
    isRefreshing: isValidating && !isLoading,
    refresh: mutate
  }
}

/**
 * The WSL distributions this install could add.
 *
 * Fetched rather than derived from the platform, and that is the point: the
 * answer describes the machine the *core* runs on, so a browser tab served by a
 * Windows install sees that install's distributions. Nothing in the renderer
 * asks what operating system it is on; an empty list is how a Mac says "not
 * here", and the Add dialog offers a WSL host exactly when the list is not
 * empty.
 *
 * `alreadyAdded` comes back joined against the host list, so the picker can grey
 * a row out rather than letting somebody press Add and read a duplicate error.
 */
export function useWslDistros(enabled = true): {
  distros: WslDistro[] | undefined
  isLoading: boolean
} {
  const { data, isLoading } = useSWR<WslDistro[], unknown>(
    enabled ? CACHE_KEYS.distros : null,
    () => api.hosts.distros()
  )
  return { distros: data, isLoading }
}

export interface HostMutations {
  addHost: (input: AddHostInput) => Promise<HostWithState>
  updateHost: (input: UpdateHostInput) => Promise<HostWithState>
  removeHost: (id: number) => Promise<void>
  probeHost: (id: number) => Promise<HostWithState>
  installOnHost: (id: number, force?: boolean) => Promise<InstallReport>
}

export function useHostMutations(): HostMutations {
  const { mutate } = useSWRConfig()
  const revalidate = useCallback(() => mutate(CACHE_KEYS.hosts), [mutate])

  return {
    addHost: useCallback(
      async (input) => {
        const created = await api.hosts.add(input)
        await revalidate()
        return created
      },
      [revalidate]
    ),
    updateHost: useCallback(
      async (input) => {
        const updated = await api.hosts.update(input)
        await revalidate()
        return updated
      },
      [revalidate]
    ),
    removeHost: useCallback(
      async (id) => {
        await api.hosts.remove({ id })
        await revalidate()
      },
      [revalidate]
    ),
    // Probe answers rather than throws for an unreachable host, so the caller
    // gets the state back *and* the list is refreshed: the probe cleared this
    // host's backoff, and a neighbour on the same machine may have come back
    // with it.
    probeHost: useCallback(
      async (id) => {
        const probed = await api.hosts.probe({ id })
        await revalidate()
        return probed
      },
      [revalidate]
    ),
    installOnHost: useCallback(
      async (id, force) => {
        const report = await api.hosts.install(force ? { id, force } : { id })
        await revalidate()
        return report
      },
      [revalidate]
    )
  }
}
