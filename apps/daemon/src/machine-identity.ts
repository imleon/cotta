import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign as signData, verify as verifyData } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { databasePath } from './cotta-home.js'

/**
 * The machine's long-lived Ed25519 identity — the daemon's equivalent of an SSH host key. It lives in its own 0600 file
 * beside the database (never inside SQLite), so copying a database never copies the identity.
 */
export type MachineIdentity = {
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string
  /** `SHA256:` + base64url digest of the raw public key; what users compare out of band. */
  fingerprint: string
  sign(data: Buffer): Buffer
}

export function identityDir(): string {
  return join(dirname(databasePath()), 'identity')
}

export function machineKeyPath(dir = identityDir()): string {
  return join(dir, 'machine.key')
}

/** Raw Ed25519 public key (base64url) from a KeyObject. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('Not an Ed25519 public key')
  return jwk.x
}

/** KeyObject for a raw Ed25519 public key (base64url); throws on anything that is not exactly 32 bytes. */
export function ed25519PublicKey(raw: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw) || Buffer.from(raw, 'base64url').length !== 32) throw new Error('Invalid Ed25519 public key')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' })
}

export function keyFingerprint(raw: string): string {
  return `SHA256:${keyId(raw)}`
}

/** URL-safe stable id derived from a raw public key (the digest behind its fingerprint). */
export function keyId(raw: string): string {
  return createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('base64url')
}

export function verifyEd25519(raw: string, data: Buffer, signature: Buffer): boolean {
  try {
    return verifyData(null, data, ed25519PublicKey(raw), signature)
  } catch {
    return false
  }
}

/** Loads the machine key, creating it (and its 0700 directory) on first use. A present but unreadable key is an error, never silently replaced. */
export function loadOrCreateMachineIdentity(dir = identityDir()): MachineIdentity {
  const path = machineKeyPath(dir)
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const { privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
  }
  const privateKey = createPrivateKey(readFileSync(path))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`Machine key at ${path} is not an Ed25519 key`)
  const publicKey = rawPublicKey(createPublicKey(privateKey))
  return { publicKey, fingerprint: keyFingerprint(publicKey), sign: (data) => signData(null, data, privateKey) }
}
