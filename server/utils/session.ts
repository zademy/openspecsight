import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Name of the session cookie set by POST /api/auth/login. HMAC-SHA256 signed
 * `{ u, exp }` payload, 7-day TTL.
 */
export const SESSION_COOKIE_NAME = 'os_session'

/** Session lifetime in milliseconds (7 days). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Session lifetime in seconds, for the cookie Max-Age attribute. */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000

/** Single-operator app: every session belongs to this pseudo-user. */
const OPERATOR_USER = 'operator'

interface SessionPayload {
  u: string
  exp: number
}

/**
 * Reads SESSION_SECRET at call time (not module load) so tests can set the
 * env per test, mirroring how getDB() reads DATABASE_PATH lazily. Throws when
 * unset so misconfiguration fails loudly at the point of use.
 */
function getSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not set; it must be a non-empty secret used to sign session tokens')
  }
  return secret
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/**
 * Creates a signed session token: `<base64url({ u, exp })>.<base64url(hmac)>`.
 * Options are test seams: `user` overrides the operator identity and `ttlMs`
 * overrides the lifetime (a negative ttl produces an already-expired token).
 */
export function createSessionToken(options: { user?: string, ttlMs?: number } = {}): string {
  const secret = getSecret()
  const payload: SessionPayload = {
    u: options.user ?? OPERATOR_USER,
    exp: Date.now() + (options.ttlMs ?? SESSION_TTL_MS),
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, secret)}`
}

/**
 * Verifies a session token: well-formed `<payload>.<signature>`, HMAC
 * signature equal in constant time, payload decodable, and not expired.
 * Returns false for any failure, including an unset SESSION_SECRET (fails
 * closed). The signature is compared as its 32-byte HMAC digest with a length
 * guard so `timingSafeEqual` never sees unequal-length buffers.
 */
export function verifySessionToken(token?: string): boolean {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return false
  }

  if (!token) {
    return false
  }
  // Strict two-segment shape: `payload.signature`. Trailing junk after a
  // valid-looking prefix (`valid.sig.junk`) must not ride on the first two
  // segments of a split.
  const parts = token.split('.')
  if (parts.length !== 2) {
    return false
  }
  const [encoded, signature] = parts
  if (!encoded || !signature) {
    return false
  }

  const expected = createHmac('sha256', secret).update(encoded).digest()
  const provided = Buffer.from(signature, 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return false
  }

  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
  } catch {
    return false
  }

  return typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > Date.now()
}

/**
 * Constant-time string comparison (e.g. the login password against
 * AUTH_PASSWORD): both sides are HMAC-digested with SESSION_SECRET first, so
 * the compared buffers are always fixed-size and neither content nor length
 * leaks through timing. Returns false when SESSION_SECRET is unset.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  let secret: string
  try {
    secret = getSecret()
  } catch {
    return false
  }
  const digestA = createHmac('sha256', secret).update(a).digest()
  const digestB = createHmac('sha256', secret).update(b).digest()
  return timingSafeEqual(digestA, digestB)
}
