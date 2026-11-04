import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createMailService,
  MailNotConfiguredError,
  NoRecipientsError,
  type MailTransport,
  type NodemailerMessage,
} from '../../server/services/mail.service'

/**
 * Mail service tests over a fake transport: the network is never touched.
 * They pin the send shape (to/from/subject/text/html reach the transport),
 * recipient dedupe, the two guard rails (no recipients, unconfigured env)
 * and the isConfigured contract that reads env at call time.
 */

const SMTP_ENV = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'mailer@example.com', SMTP_PASS: 'secret' }

function fakeTransport(): { transport: MailTransport; sent: NodemailerMessage[] } {
  const sent: NodemailerMessage[] = []
  return {
    sent,
    transport: {
      sendMail: async (message) => {
        sent.push(message)
        return { messageId: 'fake-message-id' }
      },
    },
  }
}

function sendOptions() {
  return {
    to: ['alice@example.com', 'bob@example.com'],
    subject: 'Weekly digest',
    text: '## This week',
    html: '<h2>This week</h2>',
  }
}

function clearSmtpEnv() {
  delete process.env.SMTP_HOST
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASS
  delete process.env.SMTP_FROM
}

beforeEach(() => {
  Object.assign(process.env, SMTP_ENV)
})

afterEach(clearSmtpEnv)

describe('send', () => {
  test('passes to, from, subject, text and html to the transport and returns its messageId', async () => {
    const { transport, sent } = fakeTransport()
    const mail = createMailService({ transport })

    const result = await mail.send(sendOptions())

    expect(result).toEqual({ messageId: 'fake-message-id' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      from: 'mailer@example.com',
      to: ['alice@example.com', 'bob@example.com'],
      subject: 'Weekly digest',
      text: '## This week',
      html: '<h2>This week</h2>',
    })
  })

  test('dedupes recipients while preserving order and trims addresses', async () => {
    const { transport, sent } = fakeTransport()
    const mail = createMailService({ transport })

    await mail.send({ ...sendOptions(), to: [' alice@example.com ', 'alice@example.com', 'bob@example.com', ''] })

    expect(sent[0]?.to).toEqual(['alice@example.com', 'bob@example.com'])
  })

  test('SMTP_FROM overrides the SMTP_USER default for the from address', async () => {
    process.env.SMTP_FROM = 'OpenSpecSight <digest@example.com>'
    const { transport, sent } = fakeTransport()

    await createMailService({ transport }).send(sendOptions())

    expect(sent[0]?.from).toBe('OpenSpecSight <digest@example.com>')
  })

  test('empty recipient list throws NoRecipientsError', async () => {
    const { transport, sent } = fakeTransport()

    await expect(createMailService({ transport }).send({ ...sendOptions(), to: [] }))
      .rejects.toThrow(new NoRecipientsError())
    expect(sent).toHaveLength(0)
  })

  test('whitespace-only recipient list throws NoRecipientsError', async () => {
    const { transport } = fakeTransport()

    await expect(createMailService({ transport }).send({ ...sendOptions(), to: ['   '] }))
      .rejects.toThrow(new NoRecipientsError())
  })

  test('unconfigured env throws MailNotConfiguredError naming every missing key, transport untouched', async () => {
    const { transport, sent } = fakeTransport()
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS

    const mail = createMailService({ transport })

    expect(mail.isConfigured()).toBe(false)
    await expect(mail.send(sendOptions())).rejects.toThrow(/SMTP_USER.*SMTP_PASS/)
    expect(sent).toHaveLength(0)
  })

  test('even an injected transport is refused without explicit config', async () => {
    const { transport, sent } = fakeTransport()
    clearSmtpEnv()

    await expect(createMailService({ transport }).send(sendOptions())).rejects.toThrow(MailNotConfiguredError)
    expect(sent).toHaveLength(0)
  })
})

describe('isConfigured', () => {
  test('true only when SMTP_HOST, SMTP_USER and SMTP_PASS are all set', () => {
    expect(createMailService().isConfigured()).toBe(true)
  })

  test('false until the third key lands, checked at call time', () => {
    clearSmtpEnv()
    process.env.SMTP_HOST = SMTP_ENV.SMTP_HOST
    expect(createMailService().isConfigured()).toBe(false)

    process.env.SMTP_USER = SMTP_ENV.SMTP_USER
    expect(createMailService().isConfigured()).toBe(false)

    process.env.SMTP_PASS = SMTP_ENV.SMTP_PASS
    expect(createMailService().isConfigured()).toBe(true)
  })

  test('false when a key is set but blank, read at call time', () => {
    process.env.SMTP_PASS = '   '
    expect(createMailService().isConfigured()).toBe(false)

    process.env.SMTP_PASS = 'later-secret'
    expect(createMailService().isConfigured()).toBe(true)
  })
})
