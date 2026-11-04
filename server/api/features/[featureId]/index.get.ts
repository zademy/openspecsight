import { getFeatureDetail } from '../../../services/spec.service'

/** One feature with its scenarios grouped by context. */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'featureId') ?? ''
  const id = Number(rawId)
  const detail = Number.isInteger(id) ? getFeatureDetail(id) : null
  if (!detail) {
    throw createError({ statusCode: 404, statusMessage: 'Feature not found', message: `No feature with id ${rawId}` })
  }

  return detail
})
