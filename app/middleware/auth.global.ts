/**
 * Redirects unauthenticated page visits to /login (skipping /login itself),
 * carrying the requested path in the `redirect` query so the login page can
 * return the operator where they started. API routes are not page routes —
 * they are guarded server-side by server/middleware/01.auth.ts.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') {
    return
  }

  if (!(await useAuthed())) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
