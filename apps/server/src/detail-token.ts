import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SettingsStore } from './settings-store.js'

const KEY_BYTES = 32
const SECRETS_SCOPE = 'secrets'
const DETAIL_TOKEN_KEY = 'detailTokenKey'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_TOKEN_BYTES = 2048

/** Opaque identity of a source main Agent Turn. Encrypted into the Detail token; never exposed in plaintext. */
export type DetailIdentity = {
  projectId: string
  sessionId: string
  turnId: string
}

/** Deterministic nonce = HMAC(key, canonical identity) truncated to 12 bytes. Same identity -> same nonce -> same ciphertext. */
function synthesizeNonce(plaintext: Buffer, key: Buffer): Buffer {
  return createHmac('sha256', key).update(plaintext).digest().subarray(0, NONCE_BYTES)
}

function canonicalPlaintext(identity: DetailIdentity): Buffer {
  return Buffer.from(JSON.stringify([identity.projectId, identity.sessionId, identity.turnId]), 'utf8')
}

/**
 * Deterministic authenticated encryption of a source Turn identity.
 * Synthetic-nonce AES-256-GCM: deterministic (stable URL per Turn) and opaque (no readable identity).
 */
export function encodeDetailToken(identity: DetailIdentity, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('Detail token key must be 32 bytes')
  const plaintext = canonicalPlaintext(identity)
  const nonce = synthesizeNonce(plaintext, key)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64url')
}

/** Returns the identity if the token decrypts and authenticates, else null. Never throws on malformed input. */
export function decodeDetailToken(token: string, key: Buffer): DetailIdentity | null {
  if (key.length !== KEY_BYTES || !token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return null
  let raw: Buffer
  try {
    raw = Buffer.from(token, 'base64url')
  } catch {
    return null
  }
  if (raw.length < NONCE_BYTES + TAG_BYTES) return null
  const nonce = raw.subarray(0, NONCE_BYTES)
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    // Reject tokens whose nonce was not derived from the plaintext (forgery with a mismatched nonce).
    if (!timingSafeEqual(nonce, synthesizeNonce(plaintext, key))) return null
    const parsed = JSON.parse(plaintext.toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((part) => typeof part !== 'string' || !part)) return null
    const [projectId, sessionId, turnId] = parsed as string[]
    return { projectId, sessionId, turnId }
  } catch {
    return null
  }
}

/**
 * Loads the persistent instance key for Detail tokens, generating it on first run.
 * Stored outside the 'global' settings scope so it never reaches the client via readSettings.
 */
export function loadDetailTokenKey(settingsStore: SettingsStore): Buffer {
  const existing = settingsStore.getAll(SECRETS_SCOPE)[DETAIL_TOKEN_KEY]
  if (typeof existing === 'string') {
    const key = Buffer.from(existing, 'base64')
    if (key.length === KEY_BYTES) return key
  }
  const key = randomBytes(KEY_BYTES)
  settingsStore.setMany(SECRETS_SCOPE, { [DETAIL_TOKEN_KEY]: key.toString('base64') })
  return key
}
