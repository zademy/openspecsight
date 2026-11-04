import { publishReleaseNote } from '../../../services/releaseNotes.service'

/**
 * Publishes the note: it becomes readable without a session at
 * /notes/:slug and publishedAt is stamped once. Idempotent — republishing
 * an already-published note answers 200 with the same slug and touches
 * nothing. 404 for an unknown note; no body to validate.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  const result = Number.isInteger(id) ? publishReleaseNote(id) : null
  if (!result) {
    throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: `No release note with id ${rawId}` })
  }

  return result
})
