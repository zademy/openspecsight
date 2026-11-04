import {
  WEBHOOK_SECRET_ENV,
  WebhookConfigError,
  WebhookPayloadError,
  WebhookSignatureError,
  handleGithubWebhook,
} from '../../services/webhook.service'

/**
 * The GitHub webhook, reachable without a session (the auth middleware
 * exempts exactly this path; the HMAC signature is the authentication). The
 * raw body is read before any JSON parsing because the signature is computed
 * over the raw bytes — a parsed-and-reserialized body could differ in
 * whitespace and fail verification. Status mapping: unset secret → 503, bad
 * or missing signature → 401, malformed JSON under a valid signature → 400
 * (GitHub retries; harmless). A rejected request never enqueues anything.
 */
export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8')
  try {
    return handleGithubWebhook({
      rawBody,
      eventName: getHeader(event, 'x-github-event'),
      signature: getHeader(event, 'x-hub-signature-256'),
      runTask,
    })
  } catch (error) {
    if (error instanceof WebhookConfigError) {
      throw createError({
        statusCode: 503,
        statusMessage: `${WEBHOOK_SECRET_ENV} is not set`,
        message: 'Set GITHUB_WEBHOOK_SECRET in the environment to receive GitHub webhooks.',
      })
    }
    if (error instanceof WebhookSignatureError) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid signature' })
    }
    if (error instanceof WebhookPayloadError) {
      throw createError({ statusCode: 400, statusMessage: 'Malformed payload' })
    }
    throw error
  }
})
