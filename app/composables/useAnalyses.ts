import type { AnalysisProgress } from '#shared/types'

/**
 * Analysis progress for the project overview, plus the two triggers the
 * overview owns: starting the first analysis and running a sync. Thin $fetch
 * wrappers over the analyses and sync APIs, typed from shared/types. On the
 * server the incoming cookie header is forwarded so SSR calls authenticate
 * like browser calls; the triggers run client-side only.
 */
export function useAnalyses() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response types instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function latest(projectId: number | string): Promise<AnalysisProgress | null> {
    return $fetch<AnalysisProgress | null>(`/api/projects/${projectId}/analyses`, { headers })
  }

  function start(projectId: number | string): Promise<{ analysisId: number }> {
    return $fetch<{ analysisId: number }>(`/api/projects/${projectId}/analyses`, { method: 'POST' })
  }

  function sync(projectId: number | string): Promise<{ jobId: number }> {
    return $fetch<{ jobId: number }>(`/api/projects/${projectId}/sync`, { method: 'POST' })
  }

  return { latest, start, sync }
}
