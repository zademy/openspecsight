import type { FeatureDetail, FeatureNode } from '#shared/types'

/**
 * Spec browsing data for the feature tree and feature detail pages: thin
 * $fetch wrappers over the spec API, typed from shared/types. On the server
 * the incoming cookie header is forwarded so SSR calls authenticate like
 * browser calls.
 */
export function useSpec() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response types instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function featureTree(projectId: number | string): Promise<FeatureNode[]> {
    return $fetch<FeatureNode[]>(`/api/projects/${projectId}/features`, { headers })
  }

  function featureDetail(featureId: number | string): Promise<FeatureDetail> {
    return $fetch<FeatureDetail>(`/api/features/${featureId}`, { headers })
  }

  return { featureTree, featureDetail }
}
