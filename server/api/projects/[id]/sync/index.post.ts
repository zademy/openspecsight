import { SyncInProgressError, startSync } from '../../../../services/sync.service'
import { kickJobProcessing } from '../../../../services/jobs.service'

/**
 * Starts an incremental sync of a project: creates the queued `sync` analyses
 * row, enqueues its job and answers 202 immediately. Processing is kicked off
 * in-process via the `jobs:run` Nitro task; clients poll the GET analyses
 * endpoint for progress. A second sync while one is queued or running is
 * rejected with 409; retrying a sync that ended in `error` is allowed.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  let jobId: number | null
  try {
    jobId = startSync(id)
  } catch (error) {
    if (error instanceof SyncInProgressError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Sync already in progress',
        message: 'This project already has a queued or running sync. Wait for it to finish.',
      })
    }
    throw error
  }

  if (jobId === null) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  setResponseStatus(event, 202)
  // runTask is a nitro auto-import; in-process on dev and built servers alike.
  kickJobProcessing(runTask)
  return { jobId }
})
