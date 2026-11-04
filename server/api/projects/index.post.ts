import { CreateProjectSchema } from '../../../shared/schemas'
import { createProject } from '../../services/projects.service'
import { mapProjectError } from '../../utils/projectErrors'

/**
 * Creates a project with its first repository. The payload is zod-validated,
 * the repository is checked against GitHub (defaulting the branch to the
 * repository's default branch) and an optional PAT is stored AES-256-GCM
 * encrypted. Responds 201 with the ProjectSummary — never the encrypted PAT.
 */
export default defineEventHandler(async (event) => {
  const body = CreateProjectSchema.safeParse(await readBody(event))
  if (!body.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid project',
      message: 'The project needs a name, description, owner and repository',
    })
  }

  try {
    setResponseStatus(event, 201)
    return await createProject(body.data)
  } catch (error) {
    mapProjectError(error)
  }
})
