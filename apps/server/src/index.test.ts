import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from '@cotta/shared'
import { createApp } from './index.js'

describe('server routes', () => {
  it('returns a root server page', async () => {
    const response = await createApp().request('/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Cotta v2 server is running')
  })

  it('returns the service health payload', async () => {
    const response = await createApp().request('/api/health')
    expect(response.status).toBe(200)
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      service: 'cotta-server',
    })
  })

  it('does not require token for health checks', async () => {
    const response = await createApp({ authToken: 'secret' }).request('/api/health')
    expect(response.status).toBe(200)
  })

  it('rejects protected API requests without token when auth is configured', async () => {
    const response = await createApp({ authToken: 'secret' }).request('/api/projects')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('accepts token query parameter for protected API requests', async () => {
    const response = await createApp({
      authToken: 'secret',
      claudeCodeApi: {
        async listProjects() { return [] },
        async getProject() { return null },
        async listProjectSessions() { return null },
        async getSessionMessages() { return null },
      },
    }).request('/api/projects?token=secret')
    expect(response.status).toBe(200)
  })
})
