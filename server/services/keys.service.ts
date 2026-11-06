import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Database } from '../db/client'
import { apiKeys } from '../db/schema'

/**
 * Operator API keys: a raw `sk_sp_…` key is generated and returned exactly
 * once at creation, while only its sha256 hash is stored. Verification hashes
 * the presented key and looks the hash up, so nothing server-side ever needs
 * the secret again.
 */

type ApiKeyRow = typeof apiKeys.$inferSelect

export type GeneratedApiKey = {
  key: string
  keyHash: string
  displayPrefix: string
}

export type CreatedApiKey = {
  id: string
  name: string
  displayPrefix: string
  createdAt: string
  key: string
}

export type ApiKeySummary = Omit<ApiKeyRow, 'keyHash'>

/** Error raised when the creation name is empty or longer than 60 characters. */
export class InvalidApiKeyNameError extends Error {
  constructor() {
    super('API key name must be 1 to 60 characters after trimming')
  }
}

/** Error raised when no api key exists for the requested id (HTTP 404). */
export class ApiKeyNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`No api key with id ${id}`)
  }
}

const KEY_PREFIX = 'sk_sp_'
const NAME_MAX_LENGTH = 60

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function generateApiKey(): GeneratedApiKey {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url')
  const keyHash = hashKey(key)
  const displayPrefix = `${KEY_PREFIX}${key.slice(7, 11)}…${key.slice(-4)}`
  return { key, keyHash, displayPrefix }
}

export function createApiKey(db: Database, name: string): CreatedApiKey {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > NAME_MAX_LENGTH) {
    throw new InvalidApiKeyNameError()
  }

  const generated = generateApiKey()
  const createdAt = new Date().toISOString()
  const row = db.insert(apiKeys).values({
    id: randomUUID(),
    name: trimmed,
    keyHash: generated.keyHash,
    displayPrefix: generated.displayPrefix,
    createdAt,
  }).returning().get()

  return { id: row.id, name: row.name, displayPrefix: row.displayPrefix, createdAt: row.createdAt, key: generated.key }
}

export function verifyApiKey(db: Database, key: string): ApiKeyRow | null {
  const row = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(key))).get()
  if (!row || row.revokedAt !== null) {
    return null
  }

  const lastUsedAt = new Date().toISOString()
  db.update(apiKeys).set({ lastUsedAt }).where(eq(apiKeys.id, row.id)).run()
  return { ...row, lastUsedAt }
}

export function listApiKeys(db: Database): ApiKeySummary[] {
  return db.select({
    id: apiKeys.id,
    name: apiKeys.name,
    displayPrefix: apiKeys.displayPrefix,
    createdAt: apiKeys.createdAt,
    lastUsedAt: apiKeys.lastUsedAt,
    revokedAt: apiKeys.revokedAt,
  }).from(apiKeys).orderBy(desc(apiKeys.createdAt)).all()
}

export function revokeApiKey(db: Database, id: string): boolean {
  const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
  if (!row) {
    throw new ApiKeyNotFoundError(id)
  }
  if (row.revokedAt !== null) {
    return false
  }
  db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, id)).run()
  return true
}
