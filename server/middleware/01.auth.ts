/**
 * Guards every /api/** route except the login endpoint itself: a missing or
 * invalid `os_session` cookie gets a 401. Nitro middleware runs before route
 * matching, so this 401s API routes that do not exist yet, too. Page routes
 * are guarded client-side by the global auth middleware instead.
 */
export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/') || path === '/api/auth/login') {
    return
  }

  if (!verifySessionToken(getCookie(event, SESSION_COOKIE_NAME))) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
