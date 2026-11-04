import { beforeEach, describe, expect, test } from 'vitest'
import { decryptSecret, encryptSecret } from '../../server/utils/crypto'

/**
 * The crypto utils read SESSION_SECRET lazily at call time (never at module
 * load), so setting the env var here is enough. Tests that exercise a missing
 * secret delete it explicitly.
 */
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret'
})

describe('secret encryption roundtrip', () => {
  test('decrypting an encrypted secret returns the original plaintext', () => {
    const plain = 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'

    expect(decryptSecret(encryptSecret(plain))).toBe(plain)
  })

  test('empty and unicode plaintexts survive the roundtrip', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('')
    expect(decryptSecret(encryptSecret('pát wîth ünicode ✓'))).toBe('pát wîth ünicode ✓')
  })

  test('the ciphertext uses the documented `v1:iv:tag:cipher` base64 format', () => {
    const cipher = encryptSecret('some-pat')
    const parts = cipher.split(':')

    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    }
  })

  test('encrypting the same plaintext twice yields different ciphertexts', () => {
    expect(encryptSecret('same-pat')).not.toBe(encryptSecret('same-pat'))
  })

  test('different plaintexts never collide on the same ciphertext', () => {
    expect(encryptSecret('pat-one')).not.toBe(encryptSecret('pat-two'))
  })

  test('a tampered ciphertext fails GCM authentication and throws', () => {
    const cipher = encryptSecret('ghp_tamper-target')
    const parts = cipher.split(':')
    const data = Buffer.from(parts[3], 'base64')
    // Flip one bit in the ciphertext body, then re-encode.
    data[0] ^= 0x01
    const tampered = [parts[0], parts[1], parts[2], data.toString('base64')].join(':')

    expect(() => decryptSecret(tampered)).toThrow()
  })

  test('a truncated ciphertext is rejected as a format error', () => {
    expect(() => decryptSecret('v1:not-a-real-payload')).toThrow(/v1:iv:tag:cipher/)
  })

  test('a missing SESSION_SECRET fails loudly at the point of use', () => {
    delete process.env.SESSION_SECRET

    expect(() => encryptSecret('some-pat')).toThrow(/SESSION_SECRET/)
  })
})
