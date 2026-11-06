/**
 * Pure decision logic for the auth middleware's bearer path. Everything here
 * is free of Nitro and database dependencies: the middleware extracts the raw
 * inputs (path, method, session cookie, Authorization header) and supplies
 * the real session check and key verification, while the allow/deny matrix
 * stays unit-testable in isolation.
 */

/**
 * Path prefixes a valid API key may read. Fail-closed by construction:
 * anything not listed (including routes added later) stays session-only.
 */
export const BEARER_GET_PREFIXES: readonly string[] = [
  '/api/projects',
  '/api/features',
  '/api/scenarios',
  '/api/scenario-revisions',
  '/api/releases',
  '/api/notes',
  '/api/digests',
]

export interface ApiAccessInput {
  /** Request path, e.g. `/api/projects/p1`. */
  path: string
  /** HTTP method, e.g. `GET`. HEAD is treated as GET. */
  method: string
  /** Whether the request carries a valid operator session. */
  sessionValid: boolean
  /** The presented API key, or null when no bearer credential was sent. */
  bearerKey: string | null
  /** Verification seam; true means the presented key is valid and active. */
  verify: (key: string) => boolean
}

export type ApiAccessDecision =
  | { allow: true }
  | { status: 401, message: string }
  | { status: 403, message: string }

const READ_METHODS = new Set(['GET', 'HEAD'])

const SESSION_GUARD_MESSAGE = 'Unauthorized'

/** Extracts the key from an `Authorization: Bearer <key>` header value. */
export function extractBearerKey(header: string | null | undefined): string | null {
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return null
  }
  const key = header.slice('bearer '.length).trim()
  return key.length > 0 ? key : null
}

function isBearerReadablePath(path: string): boolean {
  return BEARER_GET_PREFIXES.some((prefix) => {
    if (!path.startsWith(prefix)) {
      return false
    }
    // Boundary guard: /api/projects must not match /api/projectsXYZ, only
    // the exact path or a deeper segment.
    return path.length === prefix.length || path[prefix.length] === '/'
  })
}

/**
 * Decides access for one guarded /api request, in a pinned order:
 * a valid session always wins (any Authorization header is ignored, even a
 * stale key in the operator's browser must not break their session); then an
 * invalid bearer key is 401; then a valid bearer key is allowed for read-only
 * GET/HEAD requests on allowlisted prefixes and 403 for everything else; and
 * with no credential at all the request falls back to the session guard 401.
 */
export function resolveApiAccess(input: ApiAccessInput): ApiAccessDecision {
  if (input.sessionValid) {
    return { allow: true }
  }

  if (input.bearerKey === null || input.bearerKey.length === 0) {
    return { status: 401, message: SESSION_GUARD_MESSAGE }
  }

  if (!input.verify(input.bearerKey)) {
    return { status: 401, message: SESSION_GUARD_MESSAGE }
  }

  if (READ_METHODS.has(input.method.toUpperCase()) && isBearerReadablePath(input.path)) {
    return { allow: true }
  }

  return { status: 403, message: 'API keys are read-only.' }
}
