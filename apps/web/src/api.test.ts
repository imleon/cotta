import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindRemoteBot,
  createRemoteBot,
  deleteRemoteBot,
  deleteSession,
  ensureSessionRuntime,
  fetchAuthSession,
  fetchDailyUsage,
  fetchProjectFile,
  fetchProjectFiles,
  fetchProjects,
  fetchRemoteBots,
  fetchSessionRawMessages,
  fetchSessionTimeline,
  fetchSessionTimelineControl,
  fetchSettings,
  fetchTurnSubagentsTree,
  fetchTurnSubagentTranscript,
  fetchUsage,
  forkSession,
  logout,
  PaginationCursorStaleError,
  pollGitHubDeviceLogin,
  queryProjectSessions,
  refreshModelCatalog,
  refreshProjects,
  refreshUsage,
  renameSession,
  resolveRemoteBot,
  respondToQuestion,
  saveSettings,
  searchProjectSessions,
  setSessionPinned,
  startGitHubDeviceLogin,
  TimelineSnapshotStaleError,
  unpairRemoteBot,
  updateRemoteBot,
} from './api'

describe('project files', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads directories and files with encoded paths', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'docs #', entries: [], truncated: false, gitStatusTruncated: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'docs #/a.md', content: '# A', size: 3, revision: 'r1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProjectFiles('p/1', 'docs #')).resolves.toMatchObject({ truncated: false })
    await expect(fetchProjectFile('p/1', 'docs #/a.md')).resolves.toMatchObject({ revision: 'r1' })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/p%2F1/files?path=docs+%23')
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/p%2F1/file?path=docs+%23%2Fa.md')
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: false, user: null }), { status: 200 }))
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

describe('usage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches token usage for the selected range and configured time zone', async () => {
    const body = {
      range: '30d',
      timeZone: 'UTC',
      totals: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheHitRate: 0, sessions: 0, userMessages: 0 },
    }
    const zeroDay = { date: '2026-09-07', uncachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const dailyBody = { days: 35, timeZone: 'UTC', daily: Array.from({ length: 35 }, () => zeroDay) }
    const fetchMock = vi
      .fn<(input: string) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(dailyBody), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUsage('30d', 'Asia/Shanghai')).resolves.toEqual(body)
    await expect(fetchDailyUsage(35, 'Asia/Shanghai')).resolves.toEqual(dailyBody)
    const request = new URL(fetchMock.mock.calls[0]?.[0] ?? '', 'http://localhost')
    expect(request.pathname).toBe('/api/token-usage')
    expect(request.searchParams.get('range')).toBe('30d')
    expect(request.searchParams.get('timeZone')).toBe('Asia/Shanghai')
    const dailyRequest = new URL(fetchMock.mock.calls[1]?.[0] ?? '', 'http://localhost')
    expect(dailyRequest.pathname).toBe('/api/token-usage/daily')
    expect(dailyRequest.searchParams.get('days')).toBe('35')
    expect(dailyRequest.searchParams.get('timeZone')).toBe('Asia/Shanghai')
  })

  it('posts an explicit refresh and rejects failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response('failed', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(refreshUsage()).resolves.toBeUndefined()
    await expect(refreshUsage()).rejects.toThrow('Usage refresh failed: 503')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/token-usage/refresh', { method: 'POST' })
  })
})

describe('remote bots', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses list, CRUD, resolve, bind, and unpair endpoints', async () => {
    const bot = {
      botId: 'bot/1',
      platform: 'feishu',
      appId: 'app',
      allProjects: false,
      projectIds: ['project'],
      enabled: true,
      hasSecret: true,
      paired: false,
      pairedUserName: null,
      pairedUserAvatarUrl: null,
      connectionStatus: 'unpaired',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ bots: [bot] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bot }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ bot: { ...bot, enabled: false, connectionStatus: 'disabled' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Owner', avatarUrl: 'https://avatar/240' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ bot: { ...bot, paired: true, pairedUserName: 'Owner', pairedUserAvatarUrl: 'https://avatar/240', connectionStatus: 'connected' } }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchRemoteBots()
    await createRemoteBot({ platform: 'feishu', appId: 'app', appSecret: 'secret', allProjects: false, projectIds: ['project'] })
    await updateRemoteBot('bot/1', { enabled: false, appSecret: '' })
    await resolveRemoteBot('bot/1', 'oc_abc')
    await bindRemoteBot('bot/1', 'oc_abc')
    await unpairRemoteBot('bot/1')
    await deleteRemoteBot('bot/1')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/remote-bots')
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/remote-bots/bot%2F1', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false, appSecret: '' }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/remote-bots/bot%2F1/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatId: 'oc_abc' }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/remote-bots/bot%2F1/bind', expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatId: 'oc_abc' }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(6, '/api/remote-bots/bot%2F1/unpair', { method: 'POST' })
    expect(fetchMock).toHaveBeenNthCalledWith(7, '/api/remote-bots/bot%2F1', { method: 'DELETE' })
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { defaultPermissionMode: 'plan' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { defaultPermissionMode: 'default' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { modelCatalog: { models: [] } } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSettings()).resolves.toEqual({
      settings: { timeZone: 'Asia/Shanghai', defaultPermissionMode: 'plan', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false },
    })
    await expect(saveSettings({ defaultPermissionMode: 'default' })).resolves.toEqual({
      settings: { timeZone: 'Asia/Shanghai', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false },
    })
    await expect(refreshModelCatalog('p1')).resolves.toEqual({
      settings: { timeZone: 'Asia/Shanghai', defaultPermissionMode: 'default', defaultModel: 'default', defaultEffort: 'medium', useOneMillionContext: true, showDebugNav: false, modelCatalog: { models: [] } },
    })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/settings')
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/settings', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ settings: { defaultPermissionMode: 'default' } }) }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/settings/model-catalog/refresh?projectId=p1', { method: 'POST' })
  })
})

describe('session detail APIs', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches timeline through the session alias', async () => {
    const body = {
      sessionId: 'session-1',
      state: { sessionId: 'session-1', version: 'v1' },
      turns: [],
      runtimeTurnProjection: null,
      hasMore: false,
      hasNewer: false,
      nextCursor: null,
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [],
      snapshotFromTurnId: null,
      anchorTurnId: null,
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSessionTimeline('session/1')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2F1/timeline?limitTurns=20')

    await expect(fetchSessionTimeline('session/1', { waitContext: true, pendingSubmissionUuid: 'submission/1' })).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/session%2F1/timeline?limitTurns=20&waitContext=true&pendingSubmissionUuid=submission%2F1')
  })

  it('requests a bounded anchor timeline window', async () => {
    const body = {
      sessionId: 'session-1',
      state: { sessionId: 'session-1', version: 'v1' },
      turns: [],
      runtimeTurnProjection: null,
      hasMore: false,
      hasNewer: true,
      nextCursor: null,
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [],
      snapshotFromTurnId: null,
      anchorTurnId: 'turn/1',
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSessionTimeline('session/1', { anchorTurnId: 'turn/1', limitTurns: 7 })).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2F1/timeline?limitTurns=7&anchorTurnId=turn%2F1')
  })

  it('fetches timeline control without requesting a transcript window', async () => {
    const body = {
      sessionId: 'session-1',
      state: { sessionId: 'session-1', version: 'v1' },
      turnOptions: { permissionMode: null, model: null, effort: null },
      contextUsage: null,
      liveBackgroundTasks: null,
      runState: null,
      activity: { owner: null, phase: 'idle', activeTurnId: null },
      pendingPermission: null,
      tasks: [],
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSessionTimelineControl('session/1')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2F1/timeline?scope=control')

    await expect(fetchSessionTimelineControl('session/1', { waitContext: true })).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/session%2F1/timeline?scope=control&waitContext=true')
  })

  it('rejects mutually exclusive timeline window modes before requesting', async () => {
    await expect(fetchSessionTimeline('session/1', { cursor: 'old/1', anchorTurnId: 'turn/1' })).rejects.toThrow('Timeline cursor, fromTurnId, and anchorTurnId are mutually exclusive')
  })

  it.each([
    ['O20', 'cursor', 'old/1', 'timeline_cursor_stale'],
    ['O21', 'fromTurnId', 'turn/1', 'timeline_invalidation_stale'],
    ['S09', 'anchorTurnId', 'turn/1', 'timeline_anchor_stale'],
  ])('%s: maps a stale timeline anchor to TimelineSnapshotStaleError', async (_scenario, param, value, code) => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: code }), { status: 409 })))
    vi.stubGlobal('fetch', fetchMock)

    const request = fetchSessionTimeline('session/1', { [param]: value })
    await expect(request).rejects.toMatchObject({ message: code })
    await expect(request).rejects.toBeInstanceOf(TimelineSnapshotStaleError)
    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/session%2F1/timeline?limitTurns=20&${param}=${encodeURIComponent(value)}`)
  })

  it('submits question decisions through the dedicated endpoint', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const decision = { behavior: 'completed' as const, toolUseID: 'tool-1', answers: { 'Ship?': 'Yes' } }

    await expect(respondToQuestion('session/1', 'request/1', decision)).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/session%2F1/questions/request%2F1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(decision),
      }),
    )
  })

  it('updates pins through session aliases', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(setSessionPinned('session/1', true)).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2F1/pin', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ pinned: true }) }))
  })

  it('explains partial failure after a delete interrupt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'session_delete_failed_after_interrupt' }), { status: 500 }))),
    )
    await expect(deleteSession('project-1', 'session/1', 'session/1')).rejects.toThrow('The running turn was interrupted, but the session could not be deleted. You can retry deleting it.')
  })

  it('deletes a session with confirmation', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteSession('project-1', 'session/1', 'session/1')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/sessions/session%2F1/delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirmationSessionId: 'session/1' }),
      }),
    )
  })

  it('renames a session', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(renameSession('project-1', 'session/1', 'New title')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/sessions/session%2F1/rename',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'New title' }),
      }),
    )
  })

  it('forks a session up to a message without sending a title', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'fork-1' }), { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(forkSession('project-1', 'session/1', '123e4567-e89b-12d3-a456-426614174000')).resolves.toEqual({ projectId: 'project-1', sessionId: 'fork-1' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/sessions/session%2F1/fork',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ upToMessageId: '123e4567-e89b-12d3-a456-426614174000' }),
      }),
    )
  })

  it('forks a whole session without a message target', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ projectId: 'project-1', sessionId: 'fork-1' }), { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(forkSession('project-1', 'session/1')).resolves.toEqual({ projectId: 'project-1', sessionId: 'fork-1' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/sessions/session%2F1/fork',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )
  })

  it('ensures runtime with initialization result', async () => {
    const body = {
      ok: true,
      projectId: 'project-1',
      sessionId: 'session-1',
      settings: { permissionMode: 'default', model: null, effort: null },
      initializationResult: { models: [{ value: 'model-a' }], raw: { source: 'sdk' } },
      contextUsage: {
        model: 'model-a',
        categories: [{ name: 'Messages', tokens: 120, kind: 'used' }],
        totalTokens: 120,
        autoCompactThreshold: 160000,
        maxTokens: 200000,
        percentage: 0.06,
        updatedAtMs: 123,
      },
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureSessionRuntime('session-1')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/runtime', { method: 'POST' })
  })
})

describe('fetchSessionRawMessages', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests only the selected turn when provided', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sessionId: 'session-1', lines: [] }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await fetchSessionRawMessages('session-1', 'turn/1')

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/raw-messages?turnId=turn%2F1')
  })
})

describe('turn subagent requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests the selected turn tree', async () => {
    const body = { sessionId: 'session-1', ownerTurnId: 'turn/1', tree: [] }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTurnSubagentsTree('session/1', 'turn/1')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2F1/turns/turn%2F1/subagents/tree')
  })

  it('requests only the selected agent transcript', async () => {
    const body = { sessionId: 'session-1', ownerTurnId: 'turn/1', agentId: 'agent/1', transcript: { version: 'v1', turns: [] } }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTurnSubagentTranscript('session/1', 'turn/1', 'agent/1')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session%2F1/turns/turn%2F1/subagents/agent%2F1/transcript')
  })
})

describe('searchProjectSessions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the search request and parses the response', async () => {
    const body = {
      query: 'needle',
      totalSessions: 1,
      totalMatches: 1,
      hasMore: false,
      nextCursor: null,
      results: [
        {
          project: { id: 'p1', name: 'Project 1' },
          session: { id: 's1', title: 'Needle', projectId: 'p1', occupiedBy: null, occupiedStatus: 'idle', kind: null },
          matches: [{ field: 'title', snippet: 'Needle', ranges: [{ start: 0, end: 6 }] }],
          messageMatchCount: 0,
          truncatedMatches: false,
        },
      ],
    }
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchProjectSessions('needle', 'next-page')).resolves.toEqual(body)
    expect(fetchMock).toHaveBeenCalledWith('/api/project-sessions/search', expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'needle', cursor: 'next-page' }) }))
  })

  it('maps a stale cursor response to PaginationCursorStaleError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'pagination_cursor_stale' }), { status: 409 }))),
    )

    await expect(searchProjectSessions('needle', 'stale')).rejects.toBeInstanceOf(PaginationCursorStaleError)
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
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'pagination_cursor_stale' }), { status: 409 }))),
    )

    await expect(fetchProjects('stale')).rejects.toBeInstanceOf(PaginationCursorStaleError)
  })

  it('refreshes projects globally or by project id', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await refreshProjects()
    await refreshProjects('project/1')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/refresh', { method: 'POST' })
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/project%2F1/refresh', { method: 'POST' })
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

    await expect(Promise.all([queryProjectSessions([{ projectId: 'p1', limit: 10 }]), queryProjectSessions([{ projectId: 'p1', limit: 10 }])])).resolves.toEqual([
      { sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } },
      { sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries after an in-flight request fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionsByProject: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryProjectSessions([{ projectId: 'p1', limit: 10 }])).rejects.toThrow('Project sessions query failed: 500')
    await expect(queryProjectSessions([{ projectId: 'p1', limit: 10 }])).resolves.toEqual({ sessionsByProject: {} })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
