import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

/**
 * The Global Constraints mandate exactly these 19 env keys. `GITHUB_API_BASE`
 * is also present in the file as a deliberate extra (used by the e2e webServer
 * to point the app at the local GitHub stub).
 */
const MANDATED_KEYS: readonly string[] = [
  'DATABASE_PATH',
  'PUBLIC_APP_URL',
  'GITHUB_TOKEN',
  'GITHUB_MAX_FILES',
  'GITHUB_MAX_TOTAL_BYTES',
  'LLM_API_STYLE',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_MOCK',
  'SESSION_SECRET',
  'AUTH_PASSWORD',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'DIGEST_RECIPIENTS',
  'DIGEST_WEEKLY_ENABLED',
]

const envExample = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')

function declaredKeys(): string[] {
  return envExample
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.split('=')[0])
}

describe('.env.example', () => {
  test.each(MANDATED_KEYS)('declares %s', (key) => {
    // Anchored to the start of a line so commented-out keys do not count.
    expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'))
  })

  test('declares no keys beyond the mandated set plus the documented GITHUB_API_BASE extra', () => {
    const declared = declaredKeys()
    const unexpected = declared.filter((key) => key !== 'GITHUB_API_BASE' && !MANDATED_KEYS.includes(key))

    expect(unexpected).toEqual([])
    expect(declared).toHaveLength(MANDATED_KEYS.length + 1)
  })
})
