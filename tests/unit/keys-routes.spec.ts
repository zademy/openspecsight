import { beforeEach, describe, expect, test } from 'vitest'
import { BEARER_GET_PREFIXES, resolveApiAccess } from '../../server/utils/apiAccess'
import { getDB, resetDB, type Database } from '../../server/db/client'
import {
  ApiKeyNotFoundError,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../../server/services/keys.service'

/**
 * The keys routes are thin Nitro handlers (GET/POST /api/keys, DELETE
 * /api/keys/:id) and this repo tests them end to end, not in vitest: the
 * handlers rely on Nitro auto-imports and their HTTP surface is pinned by
 * the e2e suite. What unit tests can pin here is the composition contract
 * those handlers are built on: the exact field sets that leave the service
 * (the POST response is the only surface carrying a full key), the
 * revoke-to-status mapping, and the middleware rulings that shape the
 * routes: /api/keys stays session-only and a rejected bearer attempt still
 * counts as key use.
 */

const CREATED_FIELDS = ['id', 'name', 'displayPrefix', 'createdAt', 'key'] as const
const LISTED_FIELDS = ['id', 'name', 'displayPrefix', 'createdAt', 'lastUsedAt', 'revokedAt'] as const

beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
})

describe('response contracts', () => {
  test('the create response carries the full key exactly once, and no hash', () => {
    const db: Database = getDB()

    const created = createApiKey(db, 'route contract')

    expect(Object.keys(created).sort()).toEqual([...CREATED_FIELDS].sort())
    expect('keyHash' in created).toBe(false)
  })

  test('list rows carry prefix and timestamps only, never key or hash', () => {
    const db: Database = getDB()
    createApiKey(db, 'listed once')

    for (const row of listApiKeys(db)) {
      expect(Object.keys(row).sort()).toEqual([...LISTED_FIELDS].sort())
    }
  })
})

describe('revoke-to-status mapping', () => {
  test('204 semantics: fresh and already-revoked revokes both succeed', () => {
    const db: Database = getDB()
    const created = createApiKey(db, 'revoke me')

    expect(revokeApiKey(db, created.id)).toBe(true)
    expect(revokeApiKey(db, created.id)).toBe(false)
  })

  test('404 semantics: an unknown id raises the error the route maps to 404', () => {
    const db: Database = getDB()

    expect(() => revokeApiKey(db, 'no-such-id')).toThrow(ApiKeyNotFoundError)
  })
})

describe('middleware rulings the routes rely on', () => {
  test('/api/keys is not on the bearer allowlist, so keys stay session-only', () => {
    expect(BEARER_GET_PREFIXES).not.toContain('/api/keys')
    expect(BEARER_GET_PREFIXES.some((prefix) => '/api/keys'.startsWith(prefix))).toBe(false)
  })

  test('a rejected attempt with a live key still verifies first, so it counts as use', () => {
    const verified: string[] = []

    const decision = resolveApiAccess({
      path: '/api/keys',
      method: 'DELETE',
      sessionValid: false,
      bearerKey: 'sk_sp_live-key',
      verify: (key) => {
        verified.push(key)
        return true
      },
    })

    // The 403 (read-only rule) happens after verification, which is why the
    // settings hint says last used also moves on rejected attempts.
    expect(decision).toEqual({ status: 403, message: 'API keys are read-only.' })
    expect(verified).toEqual(['sk_sp_live-key'])
  })
})
