import { getFeatureTree } from '../../../../services/spec.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * The project's feature tree with scenario counts, in analysis order.
 * Empty until the first analysis has produced features.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return getFeatureTree(id)
})
