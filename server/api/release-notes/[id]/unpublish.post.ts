import { unpublishReleaseNote } from '../../../services/releaseNotes.service'

/**
 * Returns the note to draft: the public page 404s again. Idempotent like
 * publish; 404 for an unknown note; no body to validate.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  const result = Number.isInteger(id) ? unpublishReleaseNote(id) : null
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: `No release note with id ${rawId}` })
  }

  return result
})
