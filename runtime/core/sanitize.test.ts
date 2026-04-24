import { describe, expect, it } from 'vitest'
import { REDACTED, isSensitiveKey, sanitizeValue } from './sanitize.js'

describe('sanitizeValue', () => {
  it('redacts sensitive keys and bearer/auth tokens consistently', () => {
    const value = sanitizeValue({
      accessToken: 'secret-token',
      nested: {
        authorization: 'Bearer abc123',
        url: 'https://example.com/path?auth=my-token&ok=1',
      },
      message: 'Authorization: Bearer xyz789',
    }) as Record<string, unknown>

    expect(value.accessToken).toBe(REDACTED)
    expect(value.nested).toEqual({
      authorization: REDACTED,
      url: `https://example.com/path?auth=${REDACTED}&ok=1`,
    })
    expect(value.message).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  it('supports logger-style truncation without changing sensitive field rules', () => {
    const value = sanitizeValue({
      apiKey: 'should-hide',
      payload: [{ text: 'x'.repeat(200) }],
    }, {
      maxStringLength: 10,
      maxArrayDepth: 3,
      maxObjectDepth: 4,
      maxArrayItems: 10,
    }) as Record<string, unknown>

    expect(value.apiKey).toBe(REDACTED)
    expect(value.payload).toEqual([{ text: 'xxxxxxxxxx…' }])
  })

  it('uses the same sensitive key matcher everywhere', () => {
    expect(isSensitiveKey('token')).toBe(true)
    expect(isSensitiveKey('Authorization')).toBe(true)
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('safeField')).toBe(false)
  })
})
