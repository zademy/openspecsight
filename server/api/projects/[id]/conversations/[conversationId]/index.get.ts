import { getConversation } from '../../../../../services/conversations.service'

/** One conversation with its messages, scoped to the project. */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const projectId = Number(rawId)
  const rawCid = getRouterParam(event, 'conversationId') ?? ''
  const conversationId = Number(rawCid)

  const detail = Number.isInteger(projectId) && Number.isInteger(conversationId)
    ? getConversation(projectId, conversationId)
    : null
  if (!detail) {
    throw createError({ statusCode: 404, statusMessage: 'Conversation not found', message: `No conversation with id ${rawCid} in project ${rawId}` })
  }

  return detail
})
