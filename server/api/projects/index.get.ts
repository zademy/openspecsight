import { listProjects } from '../../services/projects.service'

/**
 * Lists every project as a summary: id, name, description and repositories
 * ({owner, repo, branch}). The encrypted PAT never appears in a response —
 * the summary type has no field for it.
 */
export default defineEventHandler(() => listProjects())
