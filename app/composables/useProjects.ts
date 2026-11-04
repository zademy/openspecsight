import type { CreateProjectInput, ProjectDetail, ProjectSummary } from '#shared/types'

/**
 * Single entry point for project data: thin $fetch wrappers over the projects
 * API, typed from shared/types. On the server the incoming cookie header is
 * forwarded so SSR calls authenticate like browser calls (the session cookie
 * is httpOnly and invisible to the app).
 */
export function useProjects() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Response types are given explicitly instead of route-matched: Nuxt 4.6's
  // $fetch path matching hits TS's instantiation limit once the route union
  // grows (nuxt/nuxt#36474, #36813) — an explicit object type param resolves
  // the response without instantiating it.
  function list(): Promise<ProjectSummary[]> {
    return $fetch<ProjectSummary[]>('/api/projects', { headers })
  }

  function get(id: number | string): Promise<ProjectDetail> {
    return $fetch<ProjectDetail>(`/api/projects/${id}`, { headers })
  }

  function create(input: CreateProjectInput): Promise<ProjectSummary> {
    return $fetch<ProjectSummary>('/api/projects', { method: 'POST', body: input })
  }

  function remove(id: number | string): Promise<{ ok: boolean }> {
    return $fetch<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
  }

  return { list, get, create, remove }
}
