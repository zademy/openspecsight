import type { AskExchange, AskQuestionInput, ConversationDetail, ConversationSummary } from '#shared/types'

/**
 * Single entry point for the ask APIs: thin $fetch wrappers over the ask and
 * conversations routes, typed from shared/types (same explicit-type-param
 * reasoning as useProjects — see the route-union note there).
 */
export function useAsk() {
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined

  function ask(projectId: number | string, input: AskQuestionInput): Promise<AskExchange> {
    return $fetch<AskExchange>(`/api/projects/${projectId}/ask`, { method: 'POST', body: input })
  }

  function conversations(projectId: number | string): Promise<ConversationSummary[]> {
    return $fetch<ConversationSummary[]>(`/api/projects/${projectId}/conversations`, { headers })
  }

  function conversation(projectId: number | string, conversationId: number | string): Promise<ConversationDetail> {
    return $fetch<ConversationDetail>(`/api/projects/${projectId}/conversations/${conversationId}`, { headers })
  }

  function remove(projectId: number | string, conversationId: number | string): Promise<{ ok: boolean }> {
    return $fetch<{ ok: boolean }>(`/api/projects/${projectId}/conversations/${conversationId}`, { method: 'DELETE' })
  }

  return { ask, conversations, conversation, remove }
}
