import { getReleaseNote } from '../../../services/releaseNotes.service'

/**
 * One release note with its parsed blocks, drafts included — the project's
 * read-only draft view reads this. 404 for an unknown id.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  const note = Number.isInteger(id) ? getReleaseNote(id) : null
  if (!note) {
    throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: `No release note with id ${rawId}` })
  }

  return note
})
