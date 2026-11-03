/**
 * Single-operator login: compares the posted password against AUTH_PASSWORD in
 * constant time and sets the signed `os_session` cookie on success. Both auth
 * env vars are required up front so a half-configured deployment fails with a
 * clear error instead of silently accepting or rejecting every password.
 */
export default defineEventHandler(async (event) => {
  const authPassword = process.env.AUTH_PASSWORD
  if (!authPassword || !process.env.SESSION_SECRET) {
    throw createError({ statusCode: 500, statusMessage: 'Auth is not configured: AUTH_PASSWORD and SESSION_SECRET must be set' })
  }

  const body = await readBody<{ password?: unknown }>(event).catch(() => null)
  const password = typeof body?.password === 'string' ? body.password : ''

  if (!timingSafeEquals(password, authPassword)) {
    throw createError({ statusCode: 401, statusMessage: 'Incorrect password' })
  }

  setCookie(event, SESSION_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })

  return { ok: true }
})
