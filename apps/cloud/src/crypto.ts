// Crockford base32 without I, L, O, U: codes are read off one screen and typed into another.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function newUserCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => CODE_ALPHABET[byte & 31]).join('')
}

export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** `SHA256:` + base64url digest of the raw key — the same fingerprint `cotta identity` prints. */
export async function keyFingerprint(publicKey: string): Promise<string> {
  return `SHA256:${base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(publicKey))))}`
}

export async function verifyEd25519(publicKey: string, message: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signature), new TextEncoder().encode(message))
  } catch {
    return false
  }
}
