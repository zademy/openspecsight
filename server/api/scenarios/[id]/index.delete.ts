import { deleteScenario } from '../../../services/spec.service'

/** Removes a scenario. Manual territory: a later sync will not re-add it. */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !deleteScenario(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Scenario not found', message: `No scenario with id ${rawId}` })
  }

  return { ok: true }
})
