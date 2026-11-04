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

  // Public surfaces skip the session guard because they authenticate by
  // content, not cookie: the public note reader only answers published
  // slugs (unknown and draft slugs share one 404), and the GitHub webhook
  // (Task 9 will add the route; its signature check comes with it). The
  // exemption is prefix-exact — /api/notes/publicX and every other /api/
  // path still 401.
  if (path.startsWith('/api/notes/public/') || path === '/api/webhooks/github') {
    return
  }

  if (!verifySessionToken(getCookie(event, SESSION_COOKIE_NAME))) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
