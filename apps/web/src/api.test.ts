import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, fetchAuthSession, fetchProjects, fetchSessionRawMessages, fetchSettings, logout, PaginationCursorStaleError, pollGitHubDeviceLogin, queryProjectSessions, refreshModelCatalog, saveSettings, startGitHubDeviceLogin } from './api'

describe('createProject', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a project with the authenticated API contract', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ project: { id: 'p1', name: 'demo', path: '/home/demo' } }), { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createProject('experiments/demo')).resolves.toEqual({ project: { id: 'p1', name: 'demo', path: '/home/demo' } })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ directoryPath: 'experiments/demo' }),
    }))
  })

  it('surfaces project creation failures with their error code', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'project_already_exists' }), { status: 409 }))))

    await expect(createProject('demo')).rejects.toMatchObject({
      status: 409,
      code: 'project_already_exists',
    })
  })
})

describe('auth', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses auth endpoints without appending the URL token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: false, user: null, githubConfigured: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ flowId: 'flow', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending', interval: 5 }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAuthSession()).resolves.toMatchObject({ authenticated: false })
    await expect(startGitHubDeviceLogin()).resolves.toMatchObject({ flowId: 'flow' })
    await expect(pollGitHubDeviceLogin('flow')).resolves.toEqual({ status: 'pending', interval: 5 })
    await expect(logout()).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/session')
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/github/device/start', { method: 'POST' })
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/auth/github/device/poll', expect.objectContaining({ method: 'POST', body: JSON.stringify({ flowId: 'flow' }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/auth/logout', { method: 'POST' })
  })
})

describe('settings', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads, saves, and refreshes settings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { defaultPermissionMode: 'plan' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { defaultPermissionMode: 'default' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { modelCatalog: { models: [] } } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSettings()).resolves.toEqual({ settings: { defaultPermissionMode: 'plan' } })
    await expect(saveSettings({ defaultPermissionMode: 'default' })).resolves.toEqual({ settings: { defaultPermissionMode: 'default' } })
    await expect(refreshModelCatalog('p1')).resolves.toEqual({ settings: { modelCatalog: { models: [] } } })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/settings')
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings', expect.objectContaining({ method: 'PUT' }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/settings/model-catalog/refresh?projectId=p1', { method: 'POST' })
  })
})

describe('fetchSessionRawMessages', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests only the selected turn when provided', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sessionId: 'session-1', messages: [] }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await fetchSessionRawMessages('project-1', 'session-1', 'turn/1')

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/sessions/session-1/raw-messages?turnId=turn%2F1')
  })
})

describe('fetchProjects', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a stale cursor response to PaginationCursorStaleError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'pagination_cursor_stale' }), { status: 409 }))))

    await expect(fetchProjects('stale')).rejects.toBeInstanceOf(PaginationCursorStaleError)
  })
})

describe('queryProjectSessions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts a fresh request for an identical payload', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(Promise.all([
      queryProjectSessions([{ projectId: 'p1', limit: 10 }]),
      queryProjectSessions([{ projectId: 'p1', limit: 10 }]),
    ])).resolves.toEqual([
      { sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } },
      { sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries after an in-flight request fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionsByProject: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryProjectSessions([{ projectId: 'p1', limit: 10 }])).rejects.toThrow('Project sessions query failed: 500')
    await expect(queryProjectSessions([{ projectId: 'p1', limit: 10 }])).resolves.toEqual({ sessionsByProject: {} })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
