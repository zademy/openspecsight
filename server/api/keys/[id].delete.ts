import { ApiKeyNotFoundError, revokeApiKey } from '../../services/keys.service'
import { getDB } from '../../db/client'

/**
 * Revokes one API key. Agents presenting it stop verifying immediately, so
 * the answer is 204 the moment the row is stamped. Revoking an already
 * revoked key is also 204; only an unknown id is 404.
 */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') ?? ''
  try {
    revokeApiKey(getDB(), id)
  } catch (cause) {
    if (cause instanceof ApiKeyNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: 'API key not found', message: cause.message })
    }
    throw cause
  }

  setResponseStatus(event, 204)
  return null
})
