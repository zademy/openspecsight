import type { MapData } from '#shared/types'

/**
 * Map data for the visualization page: a thin $fetch wrapper over the map
 * API, typed from shared/types. On the server the incoming cookie header is
 * forwarded so SSR calls authenticate like browser calls.
 */
export function useMap() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response type instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function map(projectId: number | string): Promise<MapData> {
    return $fetch<MapData>(`/api/projects/${projectId}/map`, { headers })
  }

  return { map }
}
