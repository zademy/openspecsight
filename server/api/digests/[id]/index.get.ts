import { getDigest } from '../../../services/digests.service'

/**
 * One digest with its parsed content blocks, for the digest detail page.
 * Unknown (or corrupt) ids answer 404 — the only writer stores a
 * schema-validated draft, so a parse failure means the row is broken.
 */
export default defineEventHandler((event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  const digest = Number.isInteger(id) ? getDigest(id) : null
  if (!digest) {
    throw createError({ statusCode: 404, statusMessage: 'Digest not found', message: `No digest with id ${rawId}` })
  }

  return digest
})
