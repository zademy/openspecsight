import { getLatestAnalysis } from '../../../../services/analyses.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * Latest analysis of the project as { status, progress, step, error }, or
 * null while no analysis has ever been queued. Clients poll this while the
 * status is queued or running.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  // h3 answers an empty body for a handler returning null; the contract here
  // is the JSON literal `null` until the first analysis exists, so clients
  // can keep parsing the response as JSON on every poll.
  setHeader(event, 'content-type', 'application/json')
  return JSON.stringify(getLatestAnalysis(id))
})
