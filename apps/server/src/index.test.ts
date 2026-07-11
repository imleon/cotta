import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from '@cotta/shared'
import { createApp } from './index.js'

describe('server health route', () => {
  it('returns the service health payload', async () => {
    const response = await createApp().request('/api/health')
    expect(response.status).toBe(200)
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      service: 'cotta-server',
    })
  })
})
