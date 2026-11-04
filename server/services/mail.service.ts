import nodemailer from 'nodemailer'
import type Mail from 'nodemailer/lib/mailer'

/** The message a transport receives — nodemailer's own options shape. */
export type NodemailerMessage = Mail.Options

/** Anything that can deliver a message; the seam that keeps tests off the network. */
export interface MailTransport {
  sendMail(message: NodemailerMessage): Promise<{ messageId: string }>
}

export interface MailSendOptions {
  to: string[]
  subject: string
  text: string
  html: string
}

export interface MailService {
  isConfigured(): boolean
  send(options: MailSendOptions): Promise<{ messageId: string }>
}

/** Raised when SMTP env is incomplete; the message names every missing key. */
export class MailNotConfiguredError extends Error {
  constructor(readonly missingKeys: string[]) {
    super(`Mail is not configured: missing ${missingKeys.join(', ')}`)
  }
}

/** Raised when a send has no usable recipient addresses. */
export class NoRecipientsError extends Error {
  constructor() {
    super('No recipients')
  }
}

const REQUIRED_SMTP_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const

/**
 * SMTP mail delivery. Config is "explicit": all three of SMTP_HOST,
 * SMTP_USER and SMTP_PASS must be set, and env is read at call time so a
 * fresh service picks up the current environment (repo testability
 * convention). Without explicit config nothing sends — not even through an
 * injected transport, so callers cannot accidentally email from a half-set
 * environment. The injected transport is the test seam; production gets a
 * nodemailer SMTP transport built from env (SMTP_FROM falls back to SMTP_USER).
 */
export function createMailService(deps?: { transport?: MailTransport }): MailService {
  return {
    isConfigured(): boolean {
      return missingSmtpKeys().length === 0
    },

    async send(options: MailSendOptions): Promise<{ messageId: string }> {
      const to = [...new Set(options.to.map((address) => address.trim()).filter((address) => address !== ''))]
      if (to.length === 0) throw new NoRecipientsError()

      const missingKeys = missingSmtpKeys()
      if (missingKeys.length > 0) throw new MailNotConfiguredError(missingKeys)

      const transport = deps?.transport ?? defaultTransport()
      return transport.sendMail({
        from: readEnv('SMTP_FROM') || readEnv('SMTP_USER'),
        to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      })
    },
  }
}

function readEnv(key: string): string {
  return (process.env[key] ?? '').trim()
}

function missingSmtpKeys(): string[] {
  return REQUIRED_SMTP_KEYS.filter((key) => readEnv(key) === '')
}

function defaultTransport(): MailTransport {
  const transporter = nodemailer.createTransport({
    host: readEnv('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT) || 587,
    auth: { user: readEnv('SMTP_USER'), pass: readEnv('SMTP_PASS') },
  })
  return {
    async sendMail(message: NodemailerMessage): Promise<{ messageId: string }> {
      const info = await transporter.sendMail(message)
      return { messageId: info.messageId ?? '' }
    },
  }
}
