import { AddRepositorySchema } from '../../../../../shared/schemas'
import { addRepository } from '../../../../services/projects.service'
import { mapProjectError } from '../../../../utils/projectErrors'

/**
 * Attaches another repository to an existing project. The repository is
 * validated against GitHub like on creation and the optional PAT is stored
 * encrypted. Responds with the refreshed ProjectDetail, or 404 when the
 * project does not exist.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const body = AddRepositorySchema.safeParse(await readBody(event))
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid repository',
      message: 'The repository needs an owner and a repository name',
    })
  }

  const detail = await addRepository(id, body.data).catch(mapProjectError)
  if (!detail) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return detail
})
