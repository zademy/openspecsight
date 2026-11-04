import { describe, expect, test } from 'vitest'
import { safeRedirectPath } from '../../app/utils/redirect'

/**
 * The login page follows the `redirect` query only when it is a safe
 * same-site path — the cases below are the ones a naive `startsWith('/')`
 * check lets through or mangles.
 */
describe('safeRedirectPath', () => {
  test('keeps root-relative paths', () => {
    expect(safeRedirectPath('/projects/3/spec')).toBe('/projects/3/spec')
    expect(safeRedirectPath('/')).toBe('/')
    expect(safeRedirectPath('/projects/1?tab=spec#HP-1')).toBe('/projects/1?tab=spec#HP-1')
  })

  test('rejects protocol-relative targets (`//evil.com` is off-site)', () => {
    expect(safeRedirectPath('//evil.com')).toBe('/')
    expect(safeRedirectPath('//evil.com/phish')).toBe('/')
  })

  test('rejects absolute URLs and scheme-looking values', () => {
    expect(safeRedirectPath('https://evil.com')).toBe('/')
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/')
  })

  test('rejects non-strings and falls back to the home route', () => {
    expect(safeRedirectPath(undefined)).toBe('/')
    expect(safeRedirectPath(null)).toBe('/')
    expect(safeRedirectPath(42)).toBe('/')
    expect(safeRedirectPath(['projects/1'])).toBe('/')
  })
})
