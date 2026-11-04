import type { CreateReleaseNoteInput, PublishResult, ReleaseNoteDetail, ReleaseNoteSummary } from '#shared/types'

/**
 * Release-note data for the notes pages: thin $fetch wrappers over the
 * release-notes API, typed from shared/types. On the server the incoming
 * cookie header is forwarded so SSR calls authenticate like browser calls.
 */
export function useReleaseNotes() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response types instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function list(projectId: number | string): Promise<ReleaseNoteSummary[]> {
    return $fetch<ReleaseNoteSummary[]>(`/api/projects/${projectId}/release-notes`, { headers })
  }

  function get(noteId: number | string): Promise<ReleaseNoteDetail> {
    return $fetch<ReleaseNoteDetail>(`/api/release-notes/${noteId}`, { headers })
  }

  /** Starts a draft; 202 — the client polls the list until the note appears. */
  function create(projectId: number | string, input: CreateReleaseNoteInput): Promise<{ jobId: number }> {
    return $fetch<{ jobId: number }>(`/api/projects/${projectId}/release-notes`, { method: 'POST', body: input })
  }

  /** Publishes the note; idempotent, answers the slug it is public at. */
  function publish(noteId: number | string): Promise<PublishResult> {
    return $fetch<PublishResult>(`/api/release-notes/${noteId}/publish`, { method: 'POST' })
  }

  /** Returns the note to draft; /notes/:slug 404s afterwards. */
  function unpublish(noteId: number | string): Promise<PublishResult> {
    return $fetch<PublishResult>(`/api/release-notes/${noteId}/unpublish`, { method: 'POST' })
  }

  return { list, get, create, publish, unpublish }
}
