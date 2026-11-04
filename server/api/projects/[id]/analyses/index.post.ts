import { AnalysisInProgressError, startInitialAnalysis } from '../../../../services/analyses.service'
import { kickJobProcessing } from '../../../../services/jobs.service'

/**
 * Starts the initial analysis of a project: creates the queued analyses row,
 * enqueues its job and answers 202 immediately. Processing is kicked off
 * asynchronously against the `jobs:run` Nitro task; clients poll the GET
 * endpoint for progress.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  let analysisId: number | null
  try {
    analysisId = startInitialAnalysis(id)
  } catch (error) {
    if (error instanceof AnalysisInProgressError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Analysis already in progress',
        message: 'This project already has a queued or running analysis. Wait for it to finish.',
      })
    }
    throw error
  }

  if (analysisId === null) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  setResponseStatus(event, 202)
  kickJobProcessing(getRequestURL(event).origin)
  return { analysisId }
})
