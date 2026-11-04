import { getMap } from '../../../../services/map.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * The project map: feature nodes and collapsed connection edges for the
 * visualization page. `empty: true` until an analysis has produced
 * connections — the page renders its empty state instead of a bare canvas.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return getMap(id)
})
