/**
 * The bare prefix /api/notes/public/ names no note: it answers the same
 * 404 as an unknown slug. Without this route the request fell through to
 * the page renderer, which logged vue-router no-match warnings and
 * redirected a public address to /login.
 */
export default defineEventHandler(() => {
  throw createError({ statusCode: 404, statusMessage: 'Release note not found', message: 'No published release note at this address' })
})
