import { listReleaseNotes } from '../../../../services/releaseNotes.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * The project's release notes, newest first. Drafts appear here with
 * `published: false` once their job finishes; publishing comes later.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return listReleaseNotes(id)
})
