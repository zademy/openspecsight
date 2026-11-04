import { listReleaseDays } from '../../../../services/releases.service'
import { projectExists } from '../../../../services/projects.service'
import type { ReleaseSourceFilter } from '../../../../../shared/types'

const SOURCE_FILTERS: ReleaseSourceFilter[] = ['all', 'ai', 'manual']

/**
 * The project's releases grouped by UTC calendar day, newest day first.
 * Filters: `source` (all|ai|manual — semantics documented in
 * releases.service), `feature` (feature id), `q` (title/summary search).
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const query = getQuery(event)

  const rawSource = typeof query.source === 'string' ? query.source : undefined
  if (rawSource !== undefined && !(SOURCE_FILTERS as string[]).includes(rawSource)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid source filter', message: 'source must be one of all, ai, manual' })
  }

  let featureId: number | undefined
  const rawFeature = query.feature
  if (typeof rawFeature === 'string' && rawFeature !== '') {
    featureId = Number(rawFeature)
    if (!Number.isInteger(featureId)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid feature filter', message: 'feature must be a feature id' })
    }
  }

  const q = typeof query.q === 'string' && query.q.trim() !== '' ? query.q.trim() : undefined

  return listReleaseDays(id, {
    source: rawSource === undefined ? 'all' : rawSource as ReleaseSourceFilter,
    featureId,
    q,
  })
})
