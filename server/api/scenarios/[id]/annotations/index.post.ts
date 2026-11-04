import { CreateAnnotationSchema } from '../../../../../shared/schemas'
import { addAnnotation } from '../../../../services/spec.service'

/**
 * Adds an operator note to a scenario. The author is the fixed "operator" —
 * single-operator tool.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const scenarioId = Number(rawId)
  const input = await readValidatedBody(event, CreateAnnotationSchema.parse)
  const created = Number.isInteger(scenarioId) ? addAnnotation(scenarioId, input) : null
  if (!created) {
    throw createError({ statusCode: 404, statusMessage: 'Scenario not found', message: `No scenario with id ${rawId}` })
  }

  setResponseStatus(event, 201)
  return created
})
