import { listDigests } from '../../../../services/digests.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * The project's digests, newest first. Email delivery (Task 4) sets
 * `emailedAt`; until then every digest reports it as null.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return listDigests(id)
})
