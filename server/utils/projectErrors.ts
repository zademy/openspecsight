import { GithubError } from '../services/github.service'
import { RepositoryNotFoundError } from '../services/projects.service'

/**
 * Maps project-service errors onto HTTP responses. An unknown repository is
 * the operator's typo (400, with a sentence that names the repo); any other
 * GitHub failure is an upstream problem (502). Everything else rethrows so
 * h3 renders it as before.
 */
export function mapProjectError(error: unknown): never {
  if (error instanceof RepositoryNotFoundError) {
    throw createError({
      statusCode: 400,
      statusMessage: error.message,
      message: `${error.message}. Check the owner and repository name.`,
    })
  }

  if (error instanceof GithubError) {
    throw createError({
      statusCode: 502,
      statusMessage: 'GitHub request failed',
      message: error.message,
    })
  }

  throw error
}
