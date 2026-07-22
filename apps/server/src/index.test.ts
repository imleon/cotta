import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from '@cotta/shared'
import { createApp } from './index.js'

describe('server routes', () => {
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
        async listProjects() { return { projects: [], hasMore: false, nextCursor: null } },
        async getProject() { return null },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
    }).request('/api/projects?token=secret')
    expect(response.status).toBe(200)
  })

  it('accepts bearer token for protected API requests', async () => {
    const response = await createApp({
      authToken: 'secret',
      claudeCodeApi: {
        async listProjects() { return { projects: [], hasMore: false, nextCursor: null } },
        async getProject() { return null },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
    }).request('/api/projects', { headers: { authorization: 'Bearer secret' } })
    expect(response.status).toBe(200)
  })

  it('rejects protected API requests with wrong query token', async () => {
    const response = await createApp({ authToken: 'secret' }).request('/api/projects?token=wrong')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('rejects protected API requests with wrong bearer token', async () => {
    const response = await createApp({ authToken: 'secret' }).request('/api/projects', { headers: { authorization: 'Bearer wrong' } })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('leaves protected API requests open when auth is not configured', async () => {
    const response = await createApp({
      claudeCodeApi: {
        async listProjects() { return { projects: [], hasMore: false, nextCursor: null } },
        async getProject() { return null },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
    }).request('/api/projects')
    expect(response.status).toBe(200)
  })
})
