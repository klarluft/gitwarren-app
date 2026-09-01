/**
 * Data access for the repository screens.
 *
 * SWR owns the cache; every mutation revalidates the single `repositories` key
 * rather than patching the cache by hand. That is deliberate - the list carries
 * live git state, so after any change the honest thing is to re-read it. An
 * agent may also have changed the same database through MCP, and a refetch
 * picks that up for free.
 */
import useSWR, { useSWRConfig } from 'swr'
import { useCallback } from 'react'
import { api, CACHE_KEYS } from '@/lib/api'
import type {
  AddRepositoryInput,
  Repository,
  RepositoryWithGitState,
  UpdateRepositoryInput
} from '@shared/schemas'

export interface UseRepositoriesResult {
  repositories: RepositoryWithGitState[] | undefined
  error: unknown
  isLoading: boolean
  /** True during a background refresh, when stale rows are still on screen. */
  isRefreshing: boolean
  refresh: () => Promise<unknown>
}

export function useRepositories(): UseRepositoriesResult {
  const { data, error, isLoading, isValidating, mutate } = useSWR<
    RepositoryWithGitState[],
    unknown
  >(CACHE_KEYS.repositories, () => api.repositories.list())

  return {
    repositories: data,
    error,
    isLoading,
    isRefreshing: isValidating && !isLoading,
    refresh: mutate
  }
}

export interface RepositoryMutations {
  addRepository: (input: AddRepositoryInput) => Promise<Repository>
  updateRepository: (input: UpdateRepositoryInput) => Promise<Repository>
  removeRepository: (id: number) => Promise<void>
}

export function useRepositoryMutations(): RepositoryMutations {
  const { mutate } = useSWRConfig()
  const revalidate = useCallback(() => mutate(CACHE_KEYS.repositories), [mutate])

  return {
    addRepository: useCallback(
      async (input) => {
        const created = await api.repositories.add(input)
        await revalidate()
        return created
      },
      [revalidate]
    ),
    updateRepository: useCallback(
      async (input) => {
        const updated = await api.repositories.update(input)
        await revalidate()
        return updated
      },
      [revalidate]
    ),
    removeRepository: useCallback(
      async (id) => {
        await api.repositories.remove({ id })
        await revalidate()
      },
      [revalidate]
    )
  }
}
