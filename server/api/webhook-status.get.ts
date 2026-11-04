import type { WebhookStatus } from '../../shared/types'
import { buildWebhookUrl, isWebhookSecretConfigured } from '../services/webhook.service'

/**
 * Whether the webhook secret is set, plus the URL to paste into GitHub.
 * Tiny on purpose: the settings page reads this to render the honest state —
 * the exact endpoint URL and a configured/not-configured badge — without the
 * secret itself ever leaving the server.
 */
export default defineEventHandler((): WebhookStatus => {
  return { configured: isWebhookSecretConfigured(), webhookUrl: buildWebhookUrl() }
})
