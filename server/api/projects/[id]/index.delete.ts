import { deleteProject } from '../../../services/projects.service'

/** Deletes a project and everything hanging off it (cascade). */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !deleteProject(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  return { ok: true }
})
