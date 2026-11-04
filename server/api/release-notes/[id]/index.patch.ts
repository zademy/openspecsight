import { UpdateReleaseNoteSchema } from '../../../../shared/schemas'
import { updateReleaseNote } from '../../../services/releaseNotes.service'

/**
 * The autosave endpoint: stores exactly the fields the editor sent — a
 * title-only save never touches the blocks array, and the other way
 * around. The blocks field is last-write-wins per whole array; the
 * contract lives on updateReleaseNote. 400 on an empty body, 404 unknown.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  const patch = await readValidatedBody(event, UpdateReleaseNoteSchema.parse)
  const updated = Number.isInteger(id) ? updateReleaseNote(id, patch) : null
  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: `No release note with id ${rawId}` })
  }

  return updated
})
