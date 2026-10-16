import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type DetailIdentity, decodeDetailToken, encodeDetailToken } from './detail-token.js'

const key = randomBytes(32)
const identity: DetailIdentity = { projectId: 'project-1', sessionId: 'session-1', turnId: 'turn-1' }

describe('detail token', () => {
  it('round trips an identity', () => {
    expect(decodeDetailToken(encodeDetailToken(identity, key), key)).toEqual(identity)
  })

  it('is deterministic: same identity and key yield the same token', () => {
    expect(encodeDetailToken(identity, key)).toBe(encodeDetailToken(identity, key))
  })

  it('is opaque: the token contains no readable identity', () => {
    const token = encodeDetailToken(identity, key)
    for (const value of Object.values(identity)) expect(token).not.toContain(value)
  })

  it('distinct identities yield distinct tokens', () => {
    expect(encodeDetailToken(identity, key)).not.toBe(encodeDetailToken({ ...identity, turnId: 'turn-2' }, key))
  })

  it('rejects a tampered token', () => {
    const token = encodeDetailToken(identity, key)
    const raw = Buffer.from(token, 'base64url')
    raw[raw.length - 1] ^= 0xff
    expect(decodeDetailToken(raw.toString('base64url'), key)).toBeNull()
  })

  it('rejects a token encrypted under a different key', () => {
    expect(decodeDetailToken(encodeDetailToken(identity, key), randomBytes(32))).toBeNull()
  })

  it('rejects malformed and oversized input', () => {
    expect(decodeDetailToken('', key)).toBeNull()
    expect(decodeDetailToken('not-base64url!!', key)).toBeNull()
    expect(decodeDetailToken('a'.repeat(4096), key)).toBeNull()
  })
})
