import type { ApiKeySummary } from '../../../shared/types'
import { listApiKeys } from '../../services/keys.service'
import { getDB } from '../../db/client'

/**
 * Lists every operator API key, newest first. Rows carry the display prefix
 * and timestamps only: the full key exists in exactly one response, the one
 * POST /api/keys answers at creation.
 */
export default defineEventHandler((): { keys: ApiKeySummary[] } => {
  return { keys: listApiKeys(getDB()) }
})
