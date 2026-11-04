import { exportProjectMarkdown } from '../../../../services/export.service'
import { projectExists } from '../../../../services/projects.service'

/**
 * The whole project spec as one downloadable Markdown file. The session
 * cookie rides along on the browser navigation, so the attachment is just
 * headers plus the document — no token plumbing.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id) || !projectExists(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Project not found', message: `No project with id ${rawId}` })
  }

  const { markdown, filename } = await exportProjectMarkdown(id)

  setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
  setHeader(event, 'content-disposition', `attachment; filename="${filename}"`)

  return markdown
})
