import { listAnnotations, scenarioExists } from '../../../../services/spec.service'

/** The operator's notes on one scenario, oldest first. */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !scenarioExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Scenario not found', message: `No scenario with id ${rawId}` })
  }

  return listAnnotations(id)
})
