import { AskQuestionSchema } from '../../../../../shared/schemas'
import { askInConversation, ConversationNotFoundError, ProjectNotFoundError } from '../../../../services/conversations.service'

/**
 * Asks one question into a conversation: the first question creates the
 * conversation, follow-ups append. The answer is grounded and refusal is
 * honest (ask.service); both messages land in storage before responding.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const projectId = Number(rawId)
  const input = await readValidatedBody(event, AskQuestionSchema.parse)

  try {
    return await askInConversation(projectId, input.question, input.conversationId)
  } catch (cause) {
    if (cause instanceof ProjectNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found', message: cause.message })
    }
    if (cause instanceof ConversationNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: 'Conversation not found', message: cause.message })
    }
    throw cause
  }
})
