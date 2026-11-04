import { SendDigestSchema } from '../../../../shared/schemas'
import {
  deliverDigest,
  DigestAlreadyEmailedError,
  DigestNotFoundError,
} from '../../../services/digests.service'

/**
 * Emails one digest to DIGEST_RECIPIENTS and answers with the honest
 * delivery result: `{ sent: true }`, or `{ sent: false, reason }` when no
 * recipients are set or SMTP is not configured — a 200 either way, never a
 * fake success. An already-emailed digest refuses with 409 unless the body
 * carries `force: true`, which re-sends and updates emailedAt.
 */
export default defineEventHandler(async (event) => {
  const rawId = getRouterParam(event, 'id') ?? ''
  const id = Number(rawId)
  if (!Number.isInteger(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Digest not found', message: `No digest with id ${rawId}` })
  }

  const body = await readValidatedBody(event, SendDigestSchema.parse)

  try {
    return await deliverDigest(id, { force: body.force })
  } catch (error) {
    if (error instanceof DigestNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: 'Digest not found', message: `No digest with id ${rawId}` })
    }
    if (error instanceof DigestAlreadyEmailedError) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Digest already emailed',
        message: 'This digest has already been emailed. To send it again, pass force: true.',
      })
    }
    throw error
  }
})
