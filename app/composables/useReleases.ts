import type { ReleaseDayGroup, ReleaseDetail, ReleaseListQuery } from '#shared/types'

/**
 * Changes data for the overview timeline and the changes pages: thin $fetch
 * wrappers over the releases API, typed from shared/types. On the server the
 * incoming cookie header is forwarded so SSR calls authenticate like browser
 * calls.
 */
export function useReleases() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response types instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function list(projectId: number | string, query: ReleaseListQuery = {}): Promise<ReleaseDayGroup[]> {
    return $fetch<ReleaseDayGroup[]>(`/api/projects/${projectId}/releases`, {
      headers,
      query: {
        source: query.source,
        feature: query.featureId,
        q: query.q,
      },
    })
  }

  function get(releaseId: number | string): Promise<ReleaseDetail> {
    return $fetch<ReleaseDetail>(`/api/releases/${releaseId}`, { headers })
  }

  return { list, get }
}
