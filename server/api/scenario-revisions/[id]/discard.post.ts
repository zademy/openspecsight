import { discardScenarioRevision } from '../../../services/revisions.service'

/**
 * Dismisses a proposed revision (design §6.3): the proposal is parked as
 * `discarded` and the scenario stays untouched. 404 for an unknown revision,
 * 409 when the revision is not parked as proposed (dismissing twice, or
 * after applying, is rejected).
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)

  const decision = Number.isInteger(id) ? discardScenarioRevision(id) : 'not_found'
  if (decision === 'not_found') {
    throw createError({ statusCode: 404, statusMessage: 'Revision not found', message: `No scenario revision with id ${rawId}` })
  }
  if (decision === 'not_proposed') {
    throw createError({ statusCode: 409, statusMessage: 'Revision not proposed', message: `Revision ${rawId} is not a pending suggestion` })
  }

  return { ok: true }
})
