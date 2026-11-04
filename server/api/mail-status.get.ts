import type { MailStatus } from '../../shared/types'
import { createMailService } from '../services/mail.service'

/**
 * Whether SMTP is configured, with the same call-time env check the mail
 * service applies before sending. Tiny on purpose: pages that offer email
 * (digest detail today) read this to render the honest state — a disabled
 * send action with the missing-config explanation — instead of finding out
 * from a failed send.
 */
export default defineEventHandler((): MailStatus => {
  return { configured: createMailService().isConfigured() }
})
