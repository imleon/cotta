import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, deleteSession, ensureSessionRuntime, fetchAuthSession, fetchProjects, fetchSessionInfo, fetchSessionRawMessages, fetchSettings, forkSession, logout, PaginationCursorStaleError, pollGitHubDeviceLogin, queryProjectSessions, refreshModelCatalog, renameSession, saveSettings, startGitHubDeviceLogin } from './api'

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

    await expect(fetchSettings()).resolves.toEqual({ settings: { defaultPermissionMode: 'plan', defaultModel: null, defaultEffort: null, useOneMillionContext: true } })
    await expect(saveSettings({ defaultPermissionMode: 'default' })).resolves.toEqual({ settings: { defaultPermissionMode: 'default', defaultModel: null, defaultEffort: null, useOneMillionContext: true } })
    await expect(refreshModelCatalog('p1')).resolves.toEqual({ settings: { defaultModel: null, defaultEffort: null, useOneMillionContext: true, modelCatalog: { models: [] } } })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/settings')
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ settings: { defaultPermissionMode: 'default' } }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/settings/model-catalog/refresh?projectId=p1', { method: 'POST' })
  })
})

describe('session detail APIs', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches session info', async () => {
    const body = {
      projectId: 'project-1',
      sessionId: 'session-1',
      version: 'timeline-state-v1:mtime=123;size=456',
      signature: 'mtime=123;size=456',
      generatedAt: 789,
      summary: 'Session one',
      lastModified: 123,
      fileSize: 456,
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSessionInfo('project-1', 'session/1')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/sessions/session%2F1/info')
  })

  it('deletes a session with confirmation', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteSession('project-1', 'session/1', 'session/1')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/sessions/session%2F1/delete', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ confirmationSessionId: 'session/1' }),
    }))
  })

  it('renames a session', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(renameSession('project-1', 'session/1', 'New title')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/sessions/session%2F1/rename', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'New title' }),
    }))
  })

  it('forks a session up to a message without sending a title', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'fork-1' }), { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(forkSession('project-1', 'session/1', '123e4567-e89b-12d3-a456-426614174000')).resolves.toEqual({ projectId: 'project-1', sessionId: 'fork-1' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/sessions/session%2F1/fork', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ upToMessageId: '123e4567-e89b-12d3-a456-426614174000' }),
    }))
  })

  it('forks a whole session without a message target', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'fork-1' }), { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(forkSession('project-1', 'session/1')).resolves.toEqual({ projectId: 'project-1', sessionId: 'fork-1' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/sessions/session%2F1/fork', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({}),
    }))
  })

  it('ensures runtime without catalog fields', async () => {
    const body = { ok: true, projectId: 'project-1', sessionId: 'session-1', settings: { permissionMode: 'default', model: null, effort: null } }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureSessionRuntime('project-1', 'session-1')).resolves.toEqual(body)
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
