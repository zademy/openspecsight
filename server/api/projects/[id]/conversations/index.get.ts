import { listConversations } from '../../../../services/conversations.service'

/** Lists the project's ask conversations, newest first. */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const projectId = Number(rawId)
  if (!Number.isInteger(projectId)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return listConversations(projectId)
})
