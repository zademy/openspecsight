/**
 * The login page's redirect guard: only same-site absolute paths are
 * followed. A protocol-relative `//evil.com` passes a naive `startsWith('/')`
 * check but navigates off-site, so anything that is not a root-relative path
 * falls back to the home route.
 */
export function safeRedirectPath(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}
