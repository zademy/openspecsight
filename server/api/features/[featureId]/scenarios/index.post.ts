import { CreateScenarioSchema } from '../../../../../shared/schemas'
import { createManualScenario } from '../../../../services/spec.service'

/**
 * Adds an operator-written scenario to a feature. Created with
 * `source='manual'` and the next free code in its category, so the initial
 * analysis and later syncs never overwrite it.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'featureId') ?? ''
  const featureId = Number(rawId)
  const input = await readValidatedBody(event, CreateScenarioSchema.parse)
  const created = Number.isInteger(featureId) ? createManualScenario(featureId, input) : null
  if (!created) {
    throw createError({ statusCode: 404, statusMessage: 'Feature not found', message: `No feature with id ${rawId}` })
  }

  setResponseStatus(event, 201)
  return created
})
