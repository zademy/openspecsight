import type { CreateProjectInput, ProjectDetail, ProjectSummary } from '#shared/types'

/**
 * Single entry point for project data: thin $fetch wrappers over the projects
 * API, typed from shared/types. On the server the incoming cookie header is
 * forwarded so SSR calls authenticate like browser calls (the session cookie
 * is httpOnly and invisible to the app).
 */
export function useProjects() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  function list(): Promise<ProjectSummary[]> {
    return $fetch('/api/projects', { headers })
  }

  function get(id: number | string): Promise<ProjectDetail> {
    return $fetch(`/api/projects/${id}`, { headers })
  }

  function create(input: CreateProjectInput): Promise<ProjectSummary> {
    return $fetch('/api/projects', { method: 'POST', body: input })
  }

  function remove(id: number | string): Promise<{ ok: boolean }> {
    return $fetch(`/api/projects/${id}`, { method: 'DELETE' })
  }

  return { list, get, create, remove }
}
