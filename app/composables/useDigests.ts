import type { CreateDigestInput, DigestDetail, DigestSummary, SendDigestInput, SendDigestResult } from '#shared/types'

/**
 * Digest data for the digests pages: thin $fetch wrappers over the digests
 * API, typed from shared/types. On the server the incoming cookie header is
 * forwarded so SSR calls authenticate like browser calls.
 */
export function useDigests() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  // Explicit response types instead of route-matched inference (Nuxt 4.6
  // $fetch stack-depth workaround, see useProjects).
  function list(projectId: number | string): Promise<DigestSummary[]> {
    return $fetch<DigestSummary[]>(`/api/projects/${projectId}/digests`, { headers })
  }

  function get(digestId: number | string): Promise<DigestDetail> {
    return $fetch<DigestDetail>(`/api/digests/${digestId}`, { headers })
  }

  /** Both dates optional — the server defaults to the shared window (today plus the seven days before it). */
  function create(projectId: number | string, input: CreateDigestInput = {}): Promise<{ jobId: number }> {
    return $fetch<{ jobId: number }>(`/api/projects/${projectId}/digests`, { method: 'POST', body: input })
  }

  /** Emails the digest to DIGEST_RECIPIENTS; force re-sends an emailed one. */
  function send(digestId: number | string, input: Partial<SendDigestInput> = {}): Promise<SendDigestResult> {
    return $fetch<SendDigestResult>(`/api/digests/${digestId}/send`, { method: 'POST', body: { force: false, ...input } })
  }

  return { list, get, create, send }
}
