import { deleteConversation } from '../../../../../services/conversations.service'

/** Deletes a conversation and its messages (transactional cascade). */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const projectId = Number(rawId)
  const rawCid = getRouterParam(event, 'conversationId') ?? ''
  const conversationId = Number(rawCid)

  const deleted = Number.isInteger(projectId) && Number.isInteger(conversationId)
    ? deleteConversation(projectId, conversationId)
    : false
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: 'Conversation not found', message: `No conversation with id ${rawCid} in project ${rawId}` })
  }

  return { ok: true }
})
