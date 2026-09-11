/**
 * Which machine the screen is about.
 *
 * The route already says it - `#/h/<instance>/reviews/4` is review 4 on that
 * install - but a route is read at the top of the tree and needed at the
 * bottom, by a diff line's comment composer thirty components down. Passing it
 * as a prop the whole way would mean touching every component between the two,
 * and every one of those props would be one somebody could forget to forward.
 *
 * A context instead, and one that is *read through an api* rather than as a
 * string. `useApi()` is what nearly everything uses: it hands back the app
 * bound to the current machine, so a screen goes on calling
 * `api.reviews.diff(...)` and gets the right machine's diff because of where it
 * is mounted. `useHost()` exists for the two things that genuinely need the id
 * itself - building a link that has to carry it, and keying a cache.
 *
 * ## Why a screen must never fall back to "local"
 *
 * The dangerous version of this file is one where a missing provider means
 * `undefined` means this machine. That is exactly the bug it would cause:
 * a component mounted outside the provider would quietly render local data
 * under a remote heading, and nothing about it would look wrong. So the
 * provider wraps the whole app in `App.tsx` and always supplies a value; the
 * default here is the local one because the app *is* local until a route says
 * otherwise, and there is only one route reader.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { apiFor } from './api'
import type { GitWarrenApi } from '@shared/api'
import type { HostScoped } from '@shared/routes'

interface HostScope {
  /** Instance id, or undefined for this install. */
  host: string | undefined
  api: GitWarrenApi
}

const LOCAL: HostScope = { host: undefined, api: apiFor() }

const HostScopeContext = createContext<HostScope>(LOCAL)

export function HostScopeProvider({
  host,
  children
}: {
  host: string | undefined
  children: ReactNode
}) {
  // Memoised on the id rather than rebuilt: this value is in the dependency
  // list of every fetcher below it, and a new object per render would make each
  // of them look like a change.
  const value = useMemo<HostScope>(() => ({ host, api: apiFor(host) }), [host])
  return <HostScopeContext.Provider value={value}>{children}</HostScopeContext.Provider>
}

/** The app, bound to the machine this screen is about. */
export function useApi(): GitWarrenApi {
  return useContext(HostScopeContext).api
}

/** The instance id, for a link or a cache key. Undefined means this install. */
export function useHost(): string | undefined {
  return useContext(HostScopeContext).host
}

/**
 * The host as a spreadable route fragment: `{...useHostScope()}`.
 *
 * Every `navigate` in a host-scoped screen has to carry the host or it walks
 * the user back to this machine mid-review, and a spread is the form that makes
 * that hard to get wrong - the property is either there or it is not, and
 * `{ host: undefined }` is not the same object as `{}` to anything comparing
 * two routes. That distinction is `parseRoute`'s, and this is the other end of
 * it.
 */
export function useHostScope(): HostScoped {
  const host = useHost()
  return useMemo(() => (host === undefined ? {} : { host }), [host])
}
