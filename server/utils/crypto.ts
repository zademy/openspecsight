import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/**
 * Symmetric encryption for stored third-party secrets (GitHub PATs), built on
 * AES-256-GCM. The key is derived from SESSION_SECRET with a static salt, so a
 * deployment only configures one secret; rotating SESSION_SECRET invalidates
 * every stored PAT, which is the documented trade-off. The ciphertext format is
 * `v1:iv:tag:cipher` with each part base64 (`v1` allows future migrations).
 *
 * SESSION_SECRET is read at call time (not module load) so tests can set the
 * env per test, mirroring how session.ts reads it lazily. A missing secret
 * throws at the point of use so misconfiguration fails loudly.
 */

/** Static salt that domain-separates this key from other SESSION_SECRET uses. */
const KEY_SALT = 'openspecsight:pat-encryption:v1'

const KEY_LENGTH_BYTES = 32
const IV_LENGTH_BYTES = 12
const CIPHER_FORMAT_VERSION = 'v1'

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET is not set; it must be a non-empty secret to encrypt or decrypt stored tokens')
  }

  return scryptSync(secret, KEY_SALT, KEY_LENGTH_BYTES)
}

/** Encrypts a plaintext secret into the `v1:iv:tag:cipher` base64 format. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LENGTH_BYTES)
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Base64 never contains ':', so the four-part split is unambiguous.
  return [CIPHER_FORMAT_VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':')
}

/**
 * Decrypts a `v1:iv:tag:cipher` payload back to plaintext. Throws when the
 * format is unrecognized or when authentication fails (tampered or
 * wrong-key ciphertext), never returns guessed content.
 */
export function decryptSecret(payload: string): string {
  const [version, iv, tag, cipher] = payload.split(':')
  // An empty `cipher` part is legitimate (empty plaintext), so presence is
  // checked with !== undefined instead of truthiness.
  if (version !== CIPHER_FORMAT_VERSION || iv === undefined || tag === undefined || cipher === undefined) {
    throw new Error(`Encrypted secret has an unrecognized format; expected "${CIPHER_FORMAT_VERSION}:iv:tag:cipher" in base64`)
  }

  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))

  return Buffer.concat([decipher.update(Buffer.from(cipher, 'base64')), decipher.final()]).toString('utf8')
}
