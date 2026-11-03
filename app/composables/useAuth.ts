/**
 * Asks the server whether the current session cookie is valid by calling
 * GET /api/auth/me (401 without a valid session, 200 with one). It
 * deliberately re-checks on every call and keeps no client-side state: the
 * cookie is httpOnly, so it is invisible to the app and the server is the
 * only source of truth. Resolves false on any error.
 */
export async function useAuthed(): Promise<boolean> {
  try {
    // On SSR, plain $fetch starts a fresh request that carries no cookies, so
    // the incoming request's Cookie header must be forwarded explicitly.
    const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined
    await $fetch('/api/auth/me', { headers })
    return true
  } catch {
    return false
  }
}
