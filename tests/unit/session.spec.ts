import { beforeEach, describe, expect, test } from 'vitest'
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  timingSafeEquals,
  verifySessionToken,
} from '../../server/utils/session'

/**
 * The session utils read SESSION_SECRET lazily at call time (never at module
 * load), so setting the env var here is enough. Each test starts from the same
 * secret; tests that exercise a missing secret delete it explicitly.
 */
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret'
})

describe('session token roundtrip', () => {
  test('a freshly created token verifies', () => {
    const token = createSessionToken()

    expect(verifySessionToken(token)).toBe(true)
  })

  test('the token is `<payload>.<signature>` naming the operator cookie shape', () => {
    const token = createSessionToken()

    expect(SESSION_COOKIE_NAME).toBe('os_session')
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  test('the payload carries the operator user and a ~7 day expiry', () => {
    const before = Date.now()
    const token = createSessionToken()
    const [payload] = token.split('.')

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string, exp: number }
    const weekMs = 7 * 24 * 60 * 60 * 1000

    expect(decoded.u).toBe('operator')
    expect(decoded.exp).toBeGreaterThanOrEqual(before + weekMs - 1000)
    expect(decoded.exp).toBeLessThanOrEqual(Date.now() + weekMs + 1000)
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60)
  })

  test('a custom user can be minted for tests', () => {
    const token = createSessionToken({ user: 'someone-else' })
    const [payload] = token.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string }

    expect(decoded.u).toBe('someone-else')
    expect(verifySessionToken(token)).toBe(true)
  })
})

describe('verifySessionToken rejections', () => {
  test('rejects a tampered payload', () => {
    const token = createSessionToken()
    const [, signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ u: 'operator', exp: Date.now() + 999_999_999 })).toString('base64url')

    expect(verifySessionToken(`${forged}.${signature}`)).toBe(false)
  })

  test('rejects a tampered signature', () => {
    const token = createSessionToken()
    const [payload] = token.split('.')
    const badSignature = Buffer.from('not-a-valid-signature-at-all-xxxxxx').toString('base64url')

    expect(verifySessionToken(`${payload}.${badSignature}`)).toBe(false)
  })

  test('rejects an expired token', () => {
    const token = createSessionToken({ ttlMs: -60_000 })

    expect(verifySessionToken(token)).toBe(false)
  })

  test('rejects a token signed with a different secret', () => {
    const token = createSessionToken()
    process.env.SESSION_SECRET = 'a-different-secret'

    expect(verifySessionToken(token)).toBe(false)
  })

  test('rejects missing, empty and malformed tokens', () => {
    expect(verifySessionToken(undefined)).toBe(false)
    expect(verifySessionToken('')).toBe(false)
    expect(verifySessionToken('garbage')).toBe(false)
    expect(verifySessionToken('a.b')).toBe(false)
  })

  test('rejects a valid-looking two-segment prefix carrying trailing junk', () => {
    // `valid.sig.junk` must not ride on the first two segments of a split.
    const token = createSessionToken()
    const [valid, signature] = token.split('.')

    expect(verifySessionToken(`${valid}.${signature}.junk`)).toBe(false)
  })

  test('returns false when SESSION_SECRET is unset (fail closed)', () => {
    delete process.env.SESSION_SECRET

    expect(verifySessionToken(createSessionTokenSafe())).toBe(false)
  })

  test('throws when SESSION_SECRET is unset at creation (fail loud)', () => {
    delete process.env.SESSION_SECRET

    expect(() => createSessionToken()).toThrow(/SESSION_SECRET/)
  })
})

/**
 * Helper for the fail-closed test: build a structurally valid token with the
 * secret already deleted, proving the rejection comes from the missing secret
 * (not from a malformed token).
 */
function createSessionTokenSafe(): string {
  process.env.SESSION_SECRET = 'temporary'
  const token = createSessionToken()
  process.env.SESSION_SECRET = ''
  return token
}

describe('timingSafeEquals', () => {
  test('equal strings compare equal', () => {
    expect(timingSafeEquals('test-pass', 'test-pass')).toBe(true)
  })

  test('different strings of equal length differ', () => {
    expect(timingSafeEquals('test-pass', 'test-pAss')).toBe(false)
  })

  test('different lengths never match (and never throw)', () => {
    expect(timingSafeEquals('short', 'a-much-longer-value')).toBe(false)
    expect(timingSafeEquals('', 'test-pass')).toBe(false)
  })

  test('returns false when SESSION_SECRET is unset', () => {
    delete process.env.SESSION_SECRET

    expect(timingSafeEquals('a', 'a')).toBe(false)
  })
})
