import { getReleaseDetail } from '../../../services/releases.service'

/**
 * One release with its revisions grouped by kind (new/changed/gone/fixed),
 * each resolved from the scenario snapshots the sync stored.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)

  const release = Number.isInteger(id) ? getReleaseDetail(id) : null
  if (!release) {
    throw createError({ statusCode: 404, statusMessage: 'Release not found', message: `No release with id ${rawId}` })
  }

  return release
})
