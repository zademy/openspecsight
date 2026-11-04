import type { Voice } from '#shared/types'

/**
 * Voice data for the release-note surfaces: thin $fetch wrappers over the
 * voices API, typed from shared/types. On the server the incoming cookie
 * header is forwarded so SSR calls authenticate like browser calls.
 */
export function useVoices() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response type instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function list(projectId: number | string): Promise<Voice[]> {
    return $fetch<Voice[]>(`/api/projects/${projectId}/voices`, { headers })
  }

  return { list }
}
