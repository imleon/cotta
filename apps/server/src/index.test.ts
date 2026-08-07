import { afterEach, describe, expect, it, vi } from 'vitest'
import { healthResponseSchema, type SessionRunState } from '@cotta/shared'
import { createAuth } from './auth.js'
import { createApp } from './index.js'

function emptyClaudeCodeApi() {
  return {
    async listProjects() { return { projects: [], hasMore: false, nextCursor: null } },
    async getProject() { return null },
    async listProjectSessions() { return null },
    async getSessionInfo() { return null },
    async deleteSession() { return false },
    async renameSession() { return false },
    async forkSession() { return null },
    async getSessionTimelineState() { return null },
    async getSessionMessages() { return null },
  }
}

class RunStateCacheStub {
  reader: ((sessionId: string) => SessionRunState | null) | undefined
  setSessionRunStateReader(reader: ((sessionId: string) => SessionRunState | null) | undefined) { this.reader = reader }
  async ensureReady() {}
}

function memorySettingsStore() {
  const authSessions = new Map<string, { user: { login: string; name: string | null; avatarUrl: string | null }; expiresAt: number }>()
  return {
    getAll: () => ({}),
    setMany() {},
    getAuthSession: (sessionId: string) => authSessions.get(sessionId) ?? null,
    setAuthSession: (sessionId: string, session: { user: { login: string; name: string | null; avatarUrl: string | null }; expiresAt: number }) => { authSessions.set(sessionId, session) },
    deleteAuthSession: (sessionId: string) => { authSessions.delete(sessionId) },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('server routes', () => {
  it('returns the service health payload', async () => {
    const response = await createApp().request('/api/health')
    expect(response.status).toBe(200)
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      service: 'cotta-server',
    })
  })

  it('rejects protected API requests without a GitHub session when auth is configured', async () => {
    const response = await createApp({ auth: createAuth({ github: { clientId: 'client', allowedUsers: 'imleon', sessionSecret: 'test-secret' } }) }).request('/api/projects')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns unauthenticated auth session publicly', async () => {
    const response = await createApp({ auth: createAuth({ github: { clientId: 'client', allowedUsers: 'imleon', sessionSecret: 'test-secret' } }) }).request('/api/auth/session')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false, user: null, githubConfigured: true })
  })

  it('accepts GitHub device login session cookies for protected API requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/device/code')) return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
      if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
      if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: 'Leon', avatar_url: 'https://example.com/avatar.png' }))
      return new Response('{}', { status: 404 })
    }))
    const authedApp = createApp({
      auth: createAuth({ github: { clientId: 'client', allowedUsers: 'imleon', sessionSecret: 'test-secret' } }),
      claudeCodeApi: emptyClaudeCodeApi(),
    })
    const start = await authedApp.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = await start.json() as { flowId: string }
    const poll = await authedApp.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    const cookie = poll.headers.get('set-cookie')!
    expect(cookie).toContain('cotta_session=')
    expect(cookie).toContain('HttpOnly')
    const response = await authedApp.request('/api/projects', { headers: { cookie } })
    expect(response.status).toBe(200)
  })

  it('keeps GitHub sessions after recreating auth with the same store and secret', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/device/code')) return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
      if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
      if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: null, avatar_url: null }))
      return new Response('{}', { status: 404 })
    }))
    const settingsStore = memorySettingsStore()
    const authConfig = { clientId: 'client', allowedUsers: 'imleon', sessionSecret: 'test-secret' }
    const firstApp = createApp({ auth: createAuth({ github: authConfig, settingsStore }), claudeCodeApi: emptyClaudeCodeApi() })
    const start = await firstApp.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = await start.json() as { flowId: string }
    const poll = await firstApp.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    const cookie = poll.headers.get('set-cookie')!

    const secondApp = createApp({ auth: createAuth({ github: authConfig, settingsStore }), claudeCodeApi: emptyClaudeCodeApi() })
    expect((await secondApp.request('/api/projects', { headers: { cookie } })).status).toBe(200)
    await secondApp.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect((await secondApp.request('/api/projects', { headers: { cookie } })).status).toBe(401)
  })

  it('rejects GitHub users outside the allowlist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/device/code')) return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
      if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
      if (url.includes('/user')) return new Response(JSON.stringify({ login: 'someone-else', name: null, avatar_url: null }))
      return new Response('{}', { status: 404 })
    }))
    const app = createApp({ auth: createAuth({ github: { clientId: 'client', allowedUsers: 'imleon', sessionSecret: 'test-secret' } }) })
    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = await start.json() as { flowId: string }
    const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })

    expect(poll.status).toBe(403)
    expect(await poll.json()).toEqual({ error: 'forbidden' })
  })

  it('logs out a GitHub session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/device/code')) return new Response(JSON.stringify({ device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }))
      if (url.includes('/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_token' }))
      if (url.includes('/user')) return new Response(JSON.stringify({ login: 'imleon', name: null, avatar_url: null }))
      return new Response('{}', { status: 404 })
    }))
    const app = createApp({ auth: createAuth({ github: { clientId: 'client', allowedUsers: 'imleon', sessionSecret: 'test-secret' } }), claudeCodeApi: emptyClaudeCodeApi() })
    const start = await app.request('/api/auth/github/device/start', { method: 'POST' })
    const { flowId } = await start.json() as { flowId: string }
    const poll = await app.request('/api/auth/github/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) })
    const cookie = poll.headers.get('set-cookie')!

    expect((await app.request('/api/projects', { headers: { cookie } })).status).toBe(200)
    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect(logout.status).toBe(200)
    expect(await logout.json()).toEqual({ ok: true })
    expect((await app.request('/api/projects', { headers: { cookie } })).status).toBe(401)
  })

  it('prefers precise live run state over coarse CLI registry state', async () => {
    const liveRunState: SessionRunState = { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null }
    const cache = new RunStateCacheStub()

    createApp({
      claudeCodeApi: emptyClaudeCodeApi(),
      sessionSummaryCache: cache as never,
      liveTurnManager: {
        ensureRuntime: () => {}, sessionRunState: () => liveRunState, startTurn: async () => { throw new Error('not implemented') }, interrupt: async () => false, subscribe: () => () => {},
      },
      claudeSessionRegistry: { cliSessionMetadata: () => null },
    })

    expect(cache.reader?.('session-1')).toBe(liveRunState)
  })

  it('leaves protected API requests open when GitHub auth is not configured', async () => {
    vi.stubEnv('COTTA_GITHUB_CLIENT_ID', '')
    const response = await createApp({ claudeCodeApi: emptyClaudeCodeApi() }).request('/api/projects')
    expect(response.status).toBe(200)
  })
})
