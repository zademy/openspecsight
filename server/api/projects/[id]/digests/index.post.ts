import { CreateDigestSchema } from '../../../../../shared/schemas'
import { DigestInProgressError, DigestRangeEmptyError, startDigest } from '../../../../services/digests.service'
import { kickJobProcessing } from '../../../../services/jobs.service'

/**
 * Starts a digest for the project: validates the requested range, enqueues
 * the `digest` job and answers 202 immediately. Processing is kicked off
 * in-process via the `jobs:run` Nitro task; clients poll the digest list
 * until the new digest appears. A range without releases answers 422 —
 * there is nothing to digest and saying so beats a job that can only fail.
 * A second digest while one is queued or running is rejected with 409.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const body = await readValidatedBody(event, CreateDigestSchema.parse)

  let jobId: number | null
  try {
    jobId = startDigest(id, body.rangeFrom, body.rangeTo)
  } catch (error) {
    if (error instanceof DigestInProgressError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Digest already in progress',
        message: 'This project already has a queued or running digest. Wait for it to finish.',
      })
    }
    if (error instanceof DigestRangeEmptyError) {
      throw createError({
        statusCode: 422,
        statusMessage: 'No releases in that range',
        message: error.message,
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
