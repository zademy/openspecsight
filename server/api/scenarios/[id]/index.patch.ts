import { UpdateScenarioSchema } from '../../../../shared/schemas'
import { updateScenario } from '../../../services/spec.service'

/**
 * Edits a scenario. Any accepted edit flips the row to `source='manual'`,
 * which later syncs must treat as operator territory (Task 10).
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  const patch = await readValidatedBody(event, UpdateScenarioSchema.parse)
  const updated = Number.isInteger(id) ? updateScenario(id, patch) : null
  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'Scenario not found', message: `No scenario with id ${rawId}` })
  }

  return updated
})
