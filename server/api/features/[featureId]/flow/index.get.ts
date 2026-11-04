import { getFeatureFlow } from '../../../../services/spec.service'

/**
 * One feature's flow diagram: the stored graph plus scenarioCode → live
 * scenario id links. 404 for an unknown feature and for a feature the
 * analysis drew no flow for — the spec page hides its Flow tab on the 404.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'featureId') ?? ''
  const id = Number(rawId)
  const flow = Number.isInteger(id) ? getFeatureFlow(id) : null
  if (!flow) {
    throw createError({ statusCode: 404, statusMessage: 'Flow not found', message: `No flow diagram for feature ${rawId}` })
  }

  return flow
})
