import { resolveApiAccess, extractBearerKey } from '../utils/apiAccess'
import { verifyApiKey } from '../services/keys.service'
import { getDB } from '../db/client'

/**
 * Guards every /api/** route except the login endpoint itself. A request
 * passes with either a valid `os_session` cookie (full access, any
 * Authorization header ignored) or a valid `Authorization: Bearer` API key
 * (read-only GET/HEAD on the allowlisted prefixes, see apiAccess.ts).
 * Nitro middleware runs before route matching, so this 401s API routes
 * that do not exist yet, too. Page routes are guarded client-side by the
 * global auth middleware instead.
 */
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  // /mcp does its own authentication; it never reaches the /api/ gate
  // below, but the exemption stays explicit so the intent survives.
  if (!path.startsWith('/api/') || path === '/api/auth/login' || path === '/mcp' || path.startsWith('/mcp/')) {
    return
  }

  // Public surfaces skip the session guard because they authenticate by
  // content, not cookie: the public note reader only answers published
  // slugs (unknown and draft slugs share one 404), and the GitHub webhook
  // (Task 9 will add the route; its signature check comes with it). The
  // exemption is prefix-exact: /api/notes/publicX and every other /api/
  // path still 401.
  if (path.startsWith('/api/notes/public/') || path === '/api/webhooks/github') {
    return
  }

  const decision = resolveApiAccess({
    path,
    method: getMethod(event),
    sessionValid: verifySessionToken(getCookie(event, SESSION_COOKIE_NAME)),
    bearerKey: extractBearerKey(getHeader(event, 'authorization')),
    verify: (key) => verifyApiKey(getDB(), key) !== null,
  })

  if ('allow' in decision) {
    return
  }

  throw createError({ statusCode: decision.status, statusMessage: decision.message })
})