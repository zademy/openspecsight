import { CreateReleaseNoteSchema } from '../../../../../shared/schemas'
import {
  NoteInProgressError,
  NoteScopeEmptyError,
  RevisionScopeMismatchError,
  startNoteDraft,
  VoiceNotFoundError,
} from '../../../../services/releaseNotes.service'
import { kickJobProcessing } from '../../../../services/jobs.service'

/**
 * Starts drafting a release note: validates scope and voice up front, then
 * enqueues the `release-note` job and answers 202 immediately. Processing is
 * kicked off in-process via the `jobs:run` Nitro task; clients poll the note
 * list until the new note appears. An empty selection or strangers in
 * revisionIds answer 422, an unknown voice 404, a second concurrent note job
 * for the project 409.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const body = await readValidatedBody(event, CreateReleaseNoteSchema.parse)

  let jobId: number | null
  try {
    jobId = startNoteDraft(id, body)
  } catch (error) {
    if (error instanceof NoteInProgressError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Release note already in progress',
        message: 'This project already has a queued or running release-note job. Wait for it to finish.',
      })
    }
    if (error instanceof NoteScopeEmptyError || error instanceof RevisionScopeMismatchError) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Nothing to draft',
        message: error.message,
      })
    }
    if (error instanceof VoiceNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Voice not found',
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
