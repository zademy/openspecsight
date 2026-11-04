import type { CreateVoiceInput, Voice } from '#shared/types'

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

  /** Creates a voice; the project's first one becomes the default. */
  function create(projectId: number | string, input: CreateVoiceInput): Promise<Voice> {
    return $fetch<Voice>(`/api/projects/${projectId}/voices`, { method: 'POST', body: input })
  }

  /** Points the project's default at this voice, clearing the previous one. */
  function setDefault(projectId: number | string, voiceId: number): Promise<Voice> {
    return $fetch<Voice>(`/api/projects/${projectId}/voices/${voiceId}/default`, { method: 'PATCH' })
  }

  /** Deletes a voice; notes keep the default voice, nothing breaks. */
  function remove(projectId: number | string, voiceId: number): Promise<{ ok: boolean }> {
    return $fetch<{ ok: boolean }>(`/api/projects/${projectId}/voices/${voiceId}`, { method: 'DELETE' })
  }

  return { list, create, setDefault, remove }
}
