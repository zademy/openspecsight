import type { AnalysisProgress } from '#shared/types'

/**
 * Analysis progress for the project overview: thin $fetch wrapper over the
 * analyses API, typed from shared/types. On the server the incoming cookie
 * header is forwarded so SSR calls authenticate like browser calls.
 */
export function useAnalyses() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response type instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function latest(projectId: number | string): Promise<AnalysisProgress | null> {
    return $fetch<AnalysisProgress | null>(`/api/projects/${projectId}/analyses`, { headers })
  }

  return { latest }
}
