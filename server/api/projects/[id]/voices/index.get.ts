import { listVoices } from '../../../../services/releaseNotes.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * The project's voices, oldest first. An empty array is a valid answer: the
 * implicit "Default voice" is always available without a row.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return listVoices(id)
})
