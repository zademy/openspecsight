import type { CreatedApiKey } from '../../../shared/types'
import { InvalidApiKeyNameError, createApiKey } from '../../services/keys.service'
import { getDB } from '../../db/client'

/**
 * Creates an operator API key and answers 201 with the full `sk_sp_…` key:
 * the only response in the whole app that contains it. A non-string or
 * missing name is 400, and so is a name the service rejects as empty or
 * longer than 60 characters after trimming.
 */
export default defineEventHandler(async (event): Promise<CreatedApiKey> => {
  const body = await readBody<{ name?: unknown }>(event).catch(() => null)
  const name = typeof body?.name === 'string' ? body.name : ''

  try {
    const created = createApiKey(getDB(), name)
    setResponseStatus(event, 201)
    return created
  } catch (cause) {
    if (cause instanceof InvalidApiKeyNameError) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid API key name', message: cause.message })
    }
    throw cause
  }
})
