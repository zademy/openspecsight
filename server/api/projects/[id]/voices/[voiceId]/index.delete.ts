import { deleteVoice, VoiceNotFoundError } from '../../../../../services/releaseNotes.service'
import { projectExists } from '../../../../../services/projects.service'

/**
 * Deletes a voice. Deleting the default promotes nobody: notes fall back to
 * the implicit "Default voice". An unknown voice answers 404.
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
    deleteVoice(id, voiceId)
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

  return { ok: true }
})
