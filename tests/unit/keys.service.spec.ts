import { beforeEach, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { getDB, resetDB, type Database } from '../../server/db/client'
import { apiKeys } from '../../server/db/schema'
import {
  ApiKeyNotFoundError,
  InvalidApiKeyNameError,
  createApiKey,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from '../../server/services/keys.service'

/**
 * API key service tests run against a :memory: database. Full keys are only
 * ever held in local variables; assertions use hashes and the display prefix.
 */
beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:'
  resetDB()
})

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

describe('generateApiKey', () => {
  test('formats the display prefix from the middle and tail of the key', () => {
    const generated = generateApiKey()

    expect(generated.key.startsWith('sk_sp_')).toBe(true)
    expect(generated.displayPrefix).toBe(`sk_sp_${generated.key.slice(7, 11)}…${generated.key.slice(-4)}`)
    expect(generated.keyHash).toBe(hashOf(generated.key))
  })
})

describe('createApiKey', () => {
  test('returns the raw key once and stores only the hash', () => {
    const db: Database = getDB()
    const created = createApiKey(db, 'CI token')

    expect(created.name).toBe('CI token')
    expect(created.key.startsWith('sk_sp_')).toBe(true)
    expect(Date.parse(created.createdAt)).not.toBeNaN()

    const stored = db.select({ keyHash: apiKeys.keyHash }).from(apiKeys).all()
    expect(stored).toEqual([{ keyHash: hashOf(created.key) }])
  })

  test('trims the name and persists a listable row', () => {
    const db: Database = getDB()
    const created = createApiKey(db, '  deploy bot  ')

    const rows = listApiKeys(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: created.id,
      name: 'deploy bot',
      displayPrefix: created.displayPrefix,
      createdAt: created.createdAt,
      lastUsedAt: null,
      revokedAt: null,
    })
  })

  test('rejects names that are empty, blank, or longer than 60 characters', () => {
    const db: Database = getDB()

    expect(() => createApiKey(db, '')).toThrow(InvalidApiKeyNameError)
    expect(() => createApiKey(db, '   ')).toThrow(InvalidApiKeyNameError)
    expect(() => createApiKey(db, 'a'.repeat(61))).toThrow(InvalidApiKeyNameError)
    expect(listApiKeys(db)).toHaveLength(0)
  })
})

describe('verifyApiKey', () => {
  test('accepts a fresh key and stamps lastUsedAt', () => {
    const db: Database = getDB()
    const created = createApiKey(db, 'roundtrip')

    const row = verifyApiKey(db, created.key)
    expect(row?.id).toBe(created.id)
    expect(row?.revokedAt).toBeNull()
    expect(row?.lastUsedAt).not.toBeNull()
    expect(Date.parse(row!.lastUsedAt!)).toBeGreaterThanOrEqual(Date.parse(created.createdAt))
  })

  test('rejects an unknown key', () => {
    const db: Database = getDB()
    createApiKey(db, 'real key')

    expect(verifyApiKey(db, 'sk_sp_totally-made-up')).toBeNull()
  })

  test('rejects a revoked key without touching lastUsedAt', () => {
    const db: Database = getDB()
    const created = createApiKey(db, 'doomed')
    revokeApiKey(db, created.id)

    expect(verifyApiKey(db, created.key)).toBeNull()

    const rows = listApiKeys(db)
    expect(rows[0]?.lastUsedAt).toBeNull()
    expect(rows[0]?.revokedAt).not.toBeNull()
  })
})

describe('revokeApiKey', () => {
  test('is idempotent and reports unknown ids', () => {
    const db: Database = getDB()
    const created = createApiKey(db, 'once only')

    expect(revokeApiKey(db, created.id)).toBe(true)
    expect(revokeApiKey(db, created.id)).toBe(false)
    expect(() => revokeApiKey(db, 'no-such-id')).toThrow(ApiKeyNotFoundError)
  })
})

describe('uniqueness and listing', () => {
  test('two creates produce distinct keys and hashes', () => {
    const db: Database = getDB()
    const first = createApiKey(db, 'first')
    const second = createApiKey(db, 'second')

    expect(first.key).not.toBe(second.key)
    expect(hashOf(first.key)).not.toBe(hashOf(second.key))

    const rows = listApiKeys(db)
    expect(rows).toHaveLength(2)
    expect('keyHash' in rows[0]!).toBe(false)
    expect('keyHash' in rows[1]!).toBe(false)
  })
})
