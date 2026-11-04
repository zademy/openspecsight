import type { ContentBlock, CreateReleaseNoteInput, PublishResult, ReleaseNoteDetail, ReleaseNoteSummary, UpdateReleaseNoteInput } from '#shared/types'

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

  /**
   * Autosave write: stores exactly the fields sent, so a title-only save
   * never touches the blocks array (which is last-write-wins per whole
   * array — the contract is documented on the service).
   */
  function update(noteId: number | string, patch: UpdateReleaseNoteInput): Promise<ReleaseNoteDetail> {
    return $fetch<ReleaseNoteDetail>(`/api/release-notes/${noteId}`, { method: 'PATCH', body: patch })
  }

  /** Rewrites one paragraph block in the note's voice; answers that block. */
  function enhance(noteId: number | string, index: number, instruction?: string): Promise<{ block: ContentBlock }> {
    return $fetch<{ block: ContentBlock }>(`/api/release-notes/${noteId}/blocks/${index}/enhance`, { method: 'POST', body: { instruction } })
  }

  return { list, get, create, publish, unpublish, update, enhance }

}
