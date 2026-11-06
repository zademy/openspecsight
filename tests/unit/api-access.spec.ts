import { describe, expect, test } from 'vitest'
import {
  BEARER_GET_PREFIXES,
  extractBearerKey,
  resolveApiAccess,
  type ApiAccessInput,
} from '../../server/utils/apiAccess'

/**
 * resolveApiAccess is the pure decision core of the auth middleware. These
 * tests pin the full matrix: the session-first rule (a valid session wins and
 * any Authorization header is ignored, even an invalid one), bearer
 * verification, the fail-closed read-only allowlist, HEAD counting as GET,
 * and the 401 fallbacks. The middleware only adds the public-route exemptions
 * and the real session/verify implementations on top.
 */

function decide(overrides: Partial<ApiAccessInput> = {}) {
  return resolveApiAccess({
    path: '/api/projects',
    method: 'GET',
    sessionValid: false,
    bearerKey: null,
    verify: () => false,
    ...overrides,
  })
}

describe('BEARER_GET_PREFIXES', () => {
  test('is exactly the seven read-only prefixes', () => {
    expect(BEARER_GET_PREFIXES).toEqual([
      '/api/projects',
      '/api/features',
      '/api/scenarios',
      '/api/scenario-revisions',
      '/api/releases',
      '/api/notes',
      '/api/digests',
    ])
  })
})

describe('session-first rule', () => {
  test('a valid session allows the request without consulting the key', () => {
    let verifyCalled = false

    const decision = decide({
      sessionValid: true,
      bearerKey: 'sk_sp_present-but-stale',
      verify: () => {
        verifyCalled = true
        return false
      },
    })

    expect(decision).toEqual({ allow: true })
    expect(verifyCalled).toBe(false)
  })

  test('a valid session ignores a malformed-looking header value too', () => {
    const decision = decide({ sessionValid: true, bearerKey: 'Basic dXNlcjpwYXNz' })

    expect(decision).toEqual({ allow: true })
  })

  test('a valid session alone allows the request (today\'s behavior)', () => {
    expect(decide({ sessionValid: true })).toEqual({ allow: true })
  })
})

describe('bearer verification', () => {
  test('a valid bearer key with a GET on an allowlisted prefix is allowed', () => {
    const decision = decide({ bearerKey: 'sk_sp_valid', verify: () => true })

    expect(decision).toEqual({ allow: true })
  })

  test('the presented key is handed to verify unmodified', () => {
    const seen: string[] = []

    decide({
      bearerKey: 'sk_sp_presented',
      verify: (key) => {
        seen.push(key)
        return true
      },
    })

    expect(seen).toEqual(['sk_sp_presented'])
  })

  test('an invalid bearer key is rejected with 401', () => {
    const decision = decide({ bearerKey: 'sk_sp_invalid', verify: () => false })

    expect(decision).toEqual({ status: 401, message: 'Unauthorized' })
  })

  test('an empty bearer key is rejected with 401 without reaching verify', () => {
    let verifyCalled = false

    const decision = decide({
      bearerKey: '',
      verify: () => {
        verifyCalled = true
        return true
      },
    })

    expect(decision).toEqual({ status: 401, message: 'Unauthorized' })
    expect(verifyCalled).toBe(false)
  })
})

describe('fail-closed read-only allowlist', () => {
  test('every allowlisted prefix allows a bearer GET', () => {
    for (const prefix of BEARER_GET_PREFIXES) {
      expect(decide({ path: prefix, bearerKey: 'sk_sp_valid', verify: () => true }))
        .toEqual({ allow: true })
      expect(decide({ path: `${prefix}/nested`, bearerKey: 'sk_sp_valid', verify: () => true }))
        .toEqual({ allow: true })
    }
  })

  test('a valid bearer key with GET /api/keys gets 403 (session-only route)', () => {
    const decision = decide({ path: '/api/keys', bearerKey: 'sk_sp_valid', verify: () => true })

    expect(decision).toEqual({ status: 403, message: 'API keys are read-only.' })
  })

  test('a valid bearer key with GET on a not-yet-existing route gets 403', () => {
    const decision = decide({ path: '/api/future-route', bearerKey: 'sk_sp_valid', verify: () => true })

    expect(decision).toEqual({ status: 403, message: 'API keys are read-only.' })
  })

  test('a valid bearer key with a write method gets 403', () => {
    expect(decide({ method: 'POST', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
    expect(decide({ method: 'PUT', path: '/api/projects/p1', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
    expect(decide({ method: 'DELETE', path: '/api/projects/p1', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
  })

  test('a prefix must match on a path boundary, not anywhere in the path', () => {
    expect(decide({ path: '/api/projectsXYZ', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
    expect(decide({ path: '/api/projects', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ allow: true })
    expect(decide({ path: '/api/projects/p1', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ allow: true })
  })

  test('similarly named routes do not borrow each other\'s prefix', () => {
    expect(decide({ path: '/api/scenariosXYZ', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
    expect(decide({ path: '/api/notesX/public/x', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
  })
})

describe('HEAD counts as GET', () => {
  test('a valid bearer HEAD on an allowlisted prefix is allowed', () => {
    expect(decide({ method: 'HEAD', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ allow: true })
  })

  test('a valid bearer HEAD on a session-only route gets 403', () => {
    expect(decide({ method: 'HEAD', path: '/api/keys', bearerKey: 'sk_sp_valid', verify: () => true }))
      .toEqual({ status: 403, message: 'API keys are read-only.' })
  })
})

describe('no credentials', () => {
  test('no session and no bearer key falls back to the session guard 401', () => {
    expect(decide()).toEqual({ status: 401, message: 'Unauthorized' })
  })
})

describe('extractBearerKey', () => {
  test('a missing header yields no key', () => {
    expect(extractBearerKey(undefined)).toBeNull()
    expect(extractBearerKey(null)).toBeNull()
    expect(extractBearerKey('')).toBeNull()
  })

  test('a well-formed Bearer header yields the key', () => {
    expect(extractBearerKey('Bearer sk_sp_abc123')).toBe('sk_sp_abc123')
  })

  test('the scheme matches case-insensitively', () => {
    expect(extractBearerKey('bearer sk_sp_abc123')).toBe('sk_sp_abc123')
    expect(extractBearerKey('BEARER sk_sp_abc123')).toBe('sk_sp_abc123')
  })

  test('surrounding whitespace around the key is trimmed', () => {
    expect(extractBearerKey('Bearer   sk_sp_abc123  ')).toBe('sk_sp_abc123')
  })

  test('a non-bearer scheme yields no key', () => {
    expect(extractBearerKey('Basic dXNlcjpwYXNz')).toBeNull()
  })

  test('a bare scheme with no key yields no key', () => {
    expect(extractBearerKey('Bearer')).toBeNull()
    expect(extractBearerKey('Bearer ')).toBeNull()
    expect(extractBearerKey('Bearer   ')).toBeNull()
  })
})
