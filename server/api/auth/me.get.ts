/**
 * Reachable only with a valid session — the auth middleware 401s everything
 * else under /api/** — so the 200 response itself is the "authenticated"
 * answer that useAuthed() relies on.
 */
export default defineEventHandler(() => ({ authed: true }))
