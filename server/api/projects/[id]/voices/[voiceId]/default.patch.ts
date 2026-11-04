import { setVoiceDefault, VoiceNotFoundError } from '../../../../../services/releaseNotes.service'
import { projectExists } from '../../../../../services/projects.service'

/**
 * Sets one voice as the project's default, clearing the previous one: a
 * project keeps at most one default. An unknown voice answers 404.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const rawVoiceId = getRouterParam(event, 'voiceId') ?? ''
  const voiceId = Number(rawVoiceId)

  try {
    return setVoiceDefault(id, voiceId)
  } catch (error) {
    if (error instanceof VoiceNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Voice not found',
        message: `No voice with id ${rawVoiceId} in project ${rawId}`,
      })
    }
    throw error
  }
})
