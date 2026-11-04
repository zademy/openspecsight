import type { AnnotationDTO, CreateAnnotationInput, CreateScenarioInput, ScenarioDTO, UpdateScenarioInput } from '#shared/types'

/**
 * Operator edits on the spec: create manual scenarios, edit or remove
 * existing ones, decide on parked sync proposals (apply or dismiss), and
 * read or add annotations. Only called from the browser (forms on the
 * feature detail page), so no SSR cookie forwarding.
 */
export function useScenarios() {
  function create(featureId: number | string, input: CreateScenarioInput): Promise<ScenarioDTO> {
    return $fetch<ScenarioDTO>(`/api/features/${featureId}/scenarios`, { method: 'POST', body: input })
  }

  function update(scenarioId: number, patch: UpdateScenarioInput): Promise<ScenarioDTO> {
    return $fetch<ScenarioDTO>(`/api/scenarios/${scenarioId}`, { method: 'PATCH', body: patch })
  }

  function remove(scenarioId: number): Promise<{ ok: boolean }> {
    return $fetch<{ ok: boolean }>(`/api/scenarios/${scenarioId}`, { method: 'DELETE' })
  }

  function applyProposal(revisionId: number): Promise<{ ok: boolean }> {
    return $fetch<{ ok: boolean }>(`/api/scenario-revisions/${revisionId}/apply`, { method: 'POST' })
  }

  function dismissProposal(revisionId: number): Promise<{ ok: boolean }> {
    return $fetch<{ ok: boolean }>(`/api/scenario-revisions/${revisionId}/discard`, { method: 'POST' })
  }

  function annotations(scenarioId: number): Promise<AnnotationDTO[]> {
    return $fetch<AnnotationDTO[]>(`/api/scenarios/${scenarioId}/annotations`)
  }

  function addAnnotation(scenarioId: number, input: CreateAnnotationInput): Promise<AnnotationDTO> {
    return $fetch<AnnotationDTO>(`/api/scenarios/${scenarioId}/annotations`, { method: 'POST', body: input })
  }

  return { create, update, remove, applyProposal, dismissProposal, annotations, addAnnotation }
}
