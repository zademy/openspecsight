import { CreateVoiceSchema } from '../../../../../shared/schemas'
import {
  createVoice,
  VoiceLimitReachedError,
  VoiceNameTakenError,
} from '../../../../services/releaseNotes.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * Creates a voice: the project's first voice becomes the default. A fourth
 * voice and a reused name are refused with 409 — the limit is real, and
 * renaming beats a silent fourth slot.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const body = await readValidatedBody(event, CreateVoiceSchema.parse)

  let voice
  try {
    voice = createVoice(id, body)
  } catch (error) {
    if (error instanceof VoiceLimitReachedError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Too many voices',
        message: 'A project keeps up to three voices',
      })
    }
    if (error instanceof VoiceNameTakenError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Voice name already taken',
        message: error.message,
      })
    }
    throw error
  }

  setResponseStatus(event, 201)
  return voice
})
