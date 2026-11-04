import { applyScenarioRevision } from '../../../services/revisions.service'

/**
 * Applies a proposed revision onto its scenario (design §6.3): the suggested
 * context/action/outcome/category replace the operator's text, and the
 * scenario stays `source='manual'` — the operator adopted the suggestion but
 * keeps ownership, so later syncs propose further changes instead of
 * overwriting. 404 for an unknown revision, 409 when the revision is not
 * parked as proposed (applying twice must not double-apply).
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)

  const decision = Number.isInteger(id) ? applyScenarioRevision(id) : 'not_found'
  if (decision === 'not_found') {
    throw createError({ statusCode: 404, statusMessage: 'Revision not found', message: `No scenario revision with id ${rawId}` })
  }
  if (decision === 'not_proposed') {
    throw createError({ statusCode: 409, statusMessage: 'Revision not proposed', message: `Revision ${rawId} is not a pending suggestion` })
  }

  return { ok: true }
})
