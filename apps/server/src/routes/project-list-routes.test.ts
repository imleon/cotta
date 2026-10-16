import {
  type ListVersionsEvent,
  listVersionsEventSchema,
  projectSessionSearchResponseSchema,
  projectSessionsQueryResponseSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  sessionPinsResponseSchema,
} from '@cotta/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../index.js'
import { IndexChangeNotifier } from '../index-change-notifier.js'
import { ListCursorError } from '../list-cursor.js'
import { createSseHeartbeat, SSE_HEARTBEAT_INTERVAL_MS } from './project-routes-shared.js'
import { createTestApp, memoryTranscriptIndex, messages, project, sessions } from './project-routes-test-helpers.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('project list routes', () => {
  it('lists projects from the Claude Code API adapter', async () => {
    const response = await createTestApp().request('/api/projects')

    expect(response.status).toBe(200)
    expect(projectsResponseSchema.parse(await response.json())).toEqual({ projects: [project], hasMore: false, nextCursor: null })
  })

  it('allows project windows larger than 100', async () => {
    let receivedLimit: number | undefined
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects(options) {
          receivedLimit = options?.limit
          return { projects: [], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return null
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    }).request('/api/projects?limit=101')

    expect(response.status).toBe(200)
    expect(receivedLimit).toBe(101)
  })

  it('returns a stale cursor error from projects', async () => {
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          throw new ListCursorError('stale')
        },
        async getProject() {
          return null
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    })
    const response = await app.request('/api/projects?cursor=stale')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'pagination_cursor_stale' })
  })

  it('returns a stale cursor error from project sessions', async () => {
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          throw new ListCursorError('stale')
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    })
    const response = await app.request(`/api/projects/${project.id}/sessions?cursor=stale`)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'pagination_cursor_stale' })
  })

  it('lists sessions for a project and returns the default session', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions`)

    expect(response.status).toBe(200)
    expect(projectSessionsResponseSchema.parse(await response.json())).toEqual({
      project: { ...project },
      sessions,
      defaultSessionId: 'session-newest',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('uses Cotta ownership while its runtime is active', async () => {
    const response = await createTestApp(
      {
        'session-newest': { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null },
        'session-older': { phase: 'requires_action', activeUserMessageUuid: 'user-2', lastTurn: null },
      },
      undefined,
      {
        claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'idle', hasRunningShell: true, kind: 'cli', entrypoint: 'cli' }) },
      },
    ).request(`/api/projects/${project.id}/sessions`)

    expect(response.status).toBe(200)
    expect(projectSessionsResponseSchema.parse(await response.json())).toEqual({
      project: { ...project },
      sessions: [
        { ...sessions[0], occupiedBy: 'cotta', occupiedStatus: 'busy' },
        { ...sessions[1], occupiedBy: 'cotta', occupiedStatus: 'waiting' },
      ],
      defaultSessionId: 'session-newest',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('projects unacknowledged Cotta completion outcomes', async () => {
    const response = await createTestApp({
      'session-newest': { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-1', outcome: 'success' } },
      'session-older': { phase: 'idle', activeUserMessageUuid: null, lastTurn: { id: 'user-2', outcome: 'error' } },
    }).request(`/api/projects/${project.id}/sessions`)

    expect(response.status).toBe(200)
    const body = projectSessionsResponseSchema.parse(await response.json())
    expect(body.sessions).toMatchObject([
      { id: 'session-newest', occupiedBy: 'cotta', occupiedStatus: 'idle', lastTurnOutcome: 'success' },
      { id: 'session-older', occupiedBy: 'cotta', occupiedStatus: 'idle', lastTurnOutcome: 'error' },
    ])
  })

  it('paginates project sessions', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions?limit=1`)

    expect(response.status).toBe(200)
    expect(projectSessionsResponseSchema.parse(await response.json())).toEqual({
      project: { ...project },
      sessions: [sessions[0]],
      defaultSessionId: 'session-newest',
      hasMore: true,
      nextCursor: 'session-newest',
    })
  })

  it('loads project sessions after the cursor', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions?limit=1&cursor=session-newest`)

    expect(response.status).toBe(200)
    expect(projectSessionsResponseSchema.parse(await response.json())).toEqual({
      project: { ...project },
      sessions: [sessions[1]],
      defaultSessionId: 'session-newest',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('returns 404 for unknown project sessions', async () => {
    const response = await createTestApp().request('/api/projects/missing/sessions')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'project_not_found' })
  })

  it('lists resolved session pins without deleting unresolved persisted pins', async () => {
    const pin = { projectId: project.id, sessionId: 'session-missing', pinnedAtMs: 123 }
    const unpinMany = vi.fn()
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return null
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionPinStore: { listPins: () => [pin], unpinMany } as never,
    }).request('/api/session-pins')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pins: [] })
    expect(unpinMany).not.toHaveBeenCalled()
  })

  it('warms the list index before resolving pinned sessions', async () => {
    let warmed = false
    const indexedSession = memoryTranscriptIndex().getSession('session-newest')
    if (!indexedSession) throw new Error('Expected test session')
    const getSession = vi.fn(() => (warmed ? { ...indexedSession, currentProjectId: project.id } : null))
    const listPins = vi.fn(() => [{ projectId: warmed ? project.id : '', sessionId: 'session-newest', pinnedAtMs: 123 }])
    const listProjects = vi.fn(async () => {
      warmed = true
      return { projects: [project], hasMore: false, nextCursor: null }
    })
    const getProject = vi.fn(async (projectId: string) => (projectId === project.id ? project : null))
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',
      transcriptIndex: { getSession },
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        listProjects,
        getProject,
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionPinStore: { listPins } as never,
    }).request('/api/session-pins')

    expect(response.status).toBe(200)
    expect(sessionPinsResponseSchema.parse(await response.json()).pins[0]).toMatchObject({ project, session: { id: 'session-newest' } })
    const listProjectsOrder = listProjects.mock.invocationCallOrder[0]
    const listPinsOrder = listPins.mock.invocationCallOrder[0]
    const getProjectOrder = getProject.mock.invocationCallOrder[0]
    const getSessionOrder = getSession.mock.invocationCallOrder[0]
    if (!listProjectsOrder || !listPinsOrder || !getProjectOrder || !getSessionOrder) throw new Error('Expected pin resolution calls')
    expect(listProjectsOrder).toBeLessThan(listPinsOrder)
    expect(listPinsOrder).toBeLessThan(getProjectOrder)
    expect(getProjectOrder).toBeLessThan(getSessionOrder)
  })

  it('overlays CLI metadata on resolved session pins while Cotta is idle', async () => {
    const pin = { projectId: project.id, sessionId: 'session-newest', pinnedAtMs: 123 }
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [], hasMore: false, nextCursor: null }
        },
        async getProject(projectId) {
          return projectId === project.id ? project : null
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionPinStore: { listPins: () => [pin] } as never,
      claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'busy', hasRunningShell: true, kind: 'bg', entrypoint: 'cli' }) },
    }).request('/api/session-pins')

    expect(response.status).toBe(200)
    expect(sessionPinsResponseSchema.parse(await response.json()).pins[0]?.session).toMatchObject({
      hasRunningShell: true,
      kind: 'bg',
      occupiedBy: 'external',
      occupiedStatus: 'busy',
    })
  })

  it('keeps idle shell CLI sessions externally owned', async () => {
    const response = await createTestApp({}, messages, {
      claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'idle', hasRunningShell: true, kind: null, entrypoint: 'cli' }) },
    }).request(`/api/projects/${project.id}/sessions`)

    expect(response.status).toBe(200)
    expect((await response.json()).sessions[0]).toMatchObject({ occupiedBy: 'external', occupiedStatus: 'idle', hasRunningShell: true, kind: null })
  })

  it('sends SSE heartbeats periodically and cleans up once after enqueue failure', () => {
    vi.useFakeTimers()
    const cleanup = vi.fn()
    const abortController = new AbortController()
    const controller = {
      enqueue: vi.fn(),
      close: vi.fn(() => {
        throw new Error('closed')
      }),
    } as unknown as ReadableStreamDefaultController<Uint8Array>
    createSseHeartbeat(controller, abortController.signal, cleanup)

    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS)
    expect(new TextDecoder().decode(vi.mocked(controller.enqueue).mock.calls[0]![0])).toBe(': heartbeat\n\n')
    vi.mocked(controller.enqueue).mockImplementationOnce(() => {
      throw new Error('closed')
    })
    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS)
    abortController.abort()
    vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS)

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(controller.close).toHaveBeenCalledTimes(1)
    expect(controller.enqueue).toHaveBeenCalledTimes(2)
  })

  it('streams the current list version snapshot', async () => {
    let listener: ((event: ListVersionsEvent) => void) | undefined
    const snapshot = {
      epoch: '123e4567-e89b-12d3-a456-426614174000',
      projectsVersion: 2,
      projectVersions: [{ projectId: project.id, version: 3 }],
      sessionVersions: [],
      subagentVersions: [],
      sessionChanges: [],
    }
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      indexChangeNotifier: {
        versionSnapshot: snapshot,
        publishChange: () => {},
        subscribe: (next: (event: ListVersionsEvent) => void) => {
          listener = next
          return () => {}
        },
      },
    }).request('/api/list-versions/events')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    await reader.read()
    const snapshotChunk = await reader.read()
    expect(listVersionsEventSchema.parse(JSON.parse(new TextDecoder().decode(snapshotChunk.value).replace(/^data: |\n\n$/g, '')))).toEqual(snapshot)
    await reader.cancel()
    expect(listener).toBeTypeOf('function')
  })

  it('skips selected-session watchers for missing or mismatched sessions', async () => {
    const registry = {
      acquireTask: vi.fn(async () => () => {}),
      acquireSubagent: vi.fn(async () => () => {}),
    }
    const refreshTaskSnapshot = vi.fn(async () => {})
    const refreshSubagentIndex = vi.fn(async () => false)
    const overrides = {
      sessionWatcherRegistry: registry,
      refreshTaskSnapshot,
      refreshSubagentIndex,
    }

    for (const { app, sessionId } of [
      { app: createTestApp({}, undefined, overrides), sessionId: '../../missing' },
      { app: createTestApp({}, undefined, { ...overrides, transcriptIndex: memoryTranscriptIndex('session-newest', 'project-other') }), sessionId: 'session-newest' },
    ]) {
      const response = await app.request(`/api/list-versions/events?projectId=${project.id}&sessionId=${sessionId}`)
      const reader = response.body!.getReader()
      await reader.read()
      await reader.read()
      await reader.cancel()
    }

    expect(registry.acquireTask).not.toHaveBeenCalled()
    expect(registry.acquireSubagent).not.toHaveBeenCalled()
    expect(refreshTaskSnapshot).not.toHaveBeenCalled()
    expect(refreshSubagentIndex).not.toHaveBeenCalled()
  })

  it('waits for the selected-session subagent watcher before the initial refresh', async () => {
    const releaseTask = vi.fn()
    const releaseSubagent = vi.fn()
    let resolveSubagent!: (release: () => void) => void
    let subagentChanged!: () => Promise<void>
    const registry = {
      acquireTask: vi.fn(async () => releaseTask),
      acquireSubagent: vi.fn((_sessionId: string, _transcriptPath: string, onChange: () => Promise<void>) => {
        subagentChanged = onChange
        return new Promise<() => void>((resolve) => {
          resolveSubagent = resolve
        })
      }),
    }
    const refreshTaskSnapshot = vi.fn(async () => {})
    const refreshSubagentIndex = vi.fn(async () => false)
    const notifier = new IndexChangeNotifier()
    const publishSubagentChange = vi.spyOn(notifier, 'publishSubagentChange')
    const app = createTestApp({}, undefined, {
      indexChangeNotifier: notifier,
      sessionWatcherRegistry: registry,
      refreshTaskSnapshot,
      refreshSubagentIndex,
    })
    const responsePromise = app.request(`/api/list-versions/events?projectId=${project.id}&sessionId=session-newest`)
    await vi.waitFor(() => expect(registry.acquireSubagent).toHaveBeenCalledTimes(1))
    expect(refreshSubagentIndex).not.toHaveBeenCalled()
    resolveSubagent(releaseSubagent)
    const response = await responsePromise
    const reader = response.body!.getReader()
    await reader.read()
    const snapshot = listVersionsEventSchema.parse(JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: |\n\n$/g, '')))

    expect(refreshTaskSnapshot).toHaveBeenCalledWith('session-newest', project.id)
    expect(registry.acquireTask.mock.invocationCallOrder[0]).toBeLessThan(refreshTaskSnapshot.mock.invocationCallOrder[0]!)
    expect(refreshSubagentIndex).toHaveBeenCalledWith('session-newest')
    expect(registry.acquireTask).toHaveBeenCalledTimes(1)
    expect(registry.acquireSubagent).toHaveBeenCalledWith('session-newest', '/tmp/session-newest.jsonl', expect.any(Function))
    expect(snapshot.subagentVersions).toEqual([{ projectId: project.id, sessionId: 'session-newest', version: 0, snapshot: true }])

    await subagentChanged()
    expect(refreshSubagentIndex).toHaveBeenCalledTimes(2)
    expect(publishSubagentChange).not.toHaveBeenCalled()

    refreshSubagentIndex.mockResolvedValueOnce(true)
    await subagentChanged()
    expect(publishSubagentChange).toHaveBeenCalledWith(project.id, 'session-newest')
    const update = listVersionsEventSchema.parse(JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: |\n\n$/g, '')))
    expect(update.subagentVersions).toEqual([{ projectId: project.id, sessionId: 'session-newest', version: 1 }])

    await reader.cancel()
    expect(releaseTask).toHaveBeenCalledTimes(1)
    expect(releaseSubagent).toHaveBeenCalledTimes(1)
  })

  it('publishes an initial subagent change before the snapshot and ignores watcher startup failure', async () => {
    const error = new Error('watch failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notifier = new IndexChangeNotifier()
    const publishSubagentChange = vi.spyOn(notifier, 'publishSubagentChange')
    const response = await createTestApp({}, undefined, {
      indexChangeNotifier: notifier,
      sessionWatcherRegistry: {
        acquireTask: async () => () => {},
        acquireSubagent: async () => {
          throw error
        },
      },
      refreshSubagentIndex: async () => true,
    }).request(`/api/list-versions/events?projectId=${project.id}&sessionId=session-newest`)
    const reader = response.body!.getReader()
    await reader.read()
    const snapshot = listVersionsEventSchema.parse(JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: |\n\n$/g, '')))

    expect(publishSubagentChange).toHaveBeenCalledWith(project.id, 'session-newest')
    expect(snapshot.subagentVersions).toEqual([{ projectId: project.id, sessionId: 'session-newest', version: 1, snapshot: true }])
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('session-subagent-watcher:start failed for session-newest', error))
    await reader.cancel()
  })

  it('releases a subagent watcher acquired after SSE closure and skips the initial refresh', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    const releaseTask = vi.fn()
    const releaseSubagent = vi.fn()
    let resolveTask!: (release: () => void) => void
    let resolveSubagent!: (release: () => void) => void
    const acquireSubagent = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSubagent = resolve
        }),
    )
    const refreshSubagentIndex = vi.fn(async () => false)
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const abortController = new AbortController()
    const responsePromise = createTestApp({}, undefined, {
      indexChangeNotifier: {
        versionSnapshot: { epoch: '123e4567-e89b-12d3-a456-426614174000', projectsVersion: 0, projectVersions: [], sessionVersions: [], subagentVersions: [], sessionChanges: [] },
        publishChange: () => {},
        subscribe: () => unsubscribe,
      },
      sessionWatcherRegistry: {
        acquireTask: () =>
          new Promise((resolve) => {
            resolveTask = resolve
          }),
        acquireSubagent,
      },
      refreshTaskSnapshot: async () => {},
      refreshSubagentIndex,
    }).request(`/api/list-versions/events?projectId=${project.id}&sessionId=session-newest`, { signal: abortController.signal })
    await vi.waitFor(() => expect(resolveTask).toBeTypeOf('function'))
    resolveTask(releaseTask)
    await vi.waitFor(() => expect(acquireSubagent).toHaveBeenCalledTimes(1))
    abortController.abort()
    resolveSubagent(releaseSubagent)
    const reader = (await responsePromise).body!.getReader()
    await reader.read()
    await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    expect(releaseSubagent).toHaveBeenCalledTimes(1)
    expect(refreshSubagentIndex).not.toHaveBeenCalled()

    resolveTask(releaseTask)
    await Promise.resolve()
    expect(releaseTask).toHaveBeenCalledTimes(1)
  })

  it('buffers list changes published while taking the initial snapshot', async () => {
    const change = { epoch: '123e4567-e89b-12d3-a456-426614174000', projectsVersion: 1, projectVersions: [], sessionVersions: [], subagentVersions: [], sessionChanges: [] }
    let listener: ((event: ListVersionsEvent) => void) | undefined
    const notifier = {
      get versionSnapshot() {
        listener?.(change)
        return { ...change, projectsVersion: 0 }
      },
      publishChange: () => {},
      subscribe(next: (event: ListVersionsEvent) => void) {
        listener = next
        return () => {}
      },
    }
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      indexChangeNotifier: notifier,
    }).request('/api/list-versions/events')
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    const eventChunk = await reader.read()
    expect(listVersionsEventSchema.parse(JSON.parse(new TextDecoder().decode(eventChunk.value).replace(/^data: |\n\n$/g, '')))).toEqual(change)
    await reader.cancel()
  })

  it('includes the selected session version in the reconnect snapshot', async () => {
    const notifier = new IndexChangeNotifier()
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      indexChangeNotifier: notifier,
      selectedSessionVersionReader: () => 'durable-v1',
    }).request(`/api/list-versions/events?projectId=${encodeURIComponent(project.id)}&sessionId=session-newest`)

    const reader = response.body!.getReader()
    await reader.read()
    const snapshotChunk = await reader.read()
    const snapshot = listVersionsEventSchema.parse(JSON.parse(new TextDecoder().decode(snapshotChunk.value).replace(/^data: |\n\n$/g, '')))
    expect(snapshot.sessionVersions).toEqual([{ projectId: project.id, sessionId: 'session-newest', version: 'durable-v1', snapshot: true }])
    await reader.cancel()
  })

  it.each([
    ['/api/projects/refresh', undefined],
    [`/api/projects/${project.id}/refresh`, { projectId: project.id }],
  ])('refreshes the transcript index and publishes a list change through %s', async (path, change) => {
    const syncTranscriptIndex = vi.fn(async () => {})
    const publishChange = vi.fn()
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      syncTranscriptIndex,
      indexChangeNotifier: {
        versionSnapshot: { epoch: '123e4567-e89b-12d3-a456-426614174000', projectsVersion: 0, projectVersions: [], sessionVersions: [], subagentVersions: [], sessionChanges: [] },
        subscribe: () => () => {},
        publishChange,
      },
    }).request(path, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    if (change) {
      expect(syncTranscriptIndex).toHaveBeenCalledWith(change)
      expect(publishChange).toHaveBeenCalledWith(change)
    } else {
      expect(syncTranscriptIndex).toHaveBeenCalledWith()
      expect(publishChange).toHaveBeenCalledWith()
    }
  })

  it('returns refresh unavailable without a summary cache', async () => {
    const response = await createTestApp().request('/api/projects/refresh', { method: 'POST' })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'projects_refresh_unavailable' })
  })

  it('returns batch project sessions for requested projects only', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: (sessionId: string) => (sessionId === 'session-newest' ? { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null } : null),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions(projectId) {
          return projectId === project.id ? { project, sessions, defaultSessionId: sessions[0]!.id, hasMore: false, nextCursor: null } : null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projects: [
          { projectId: project.id, limit: 2 },
          { projectId: 'missing', limit: 1 },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({
      sessionsByProject: {
        [project.id]: {
          sessions: [{ ...sessions[0], occupiedBy: 'cotta', occupiedStatus: 'busy' }, sessions[1]],
          hasMore: false,
          nextCursor: null,
        },
      },
    })
  })

  it('searches project sessions', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: (sessionId: string) => (sessionId === 'session-newest' ? { phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null } : null),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionSearchStore: {
        updateTitle: () => true,
        search: () => ({
          query: 'Newest',
          totalSessions: 1,
          totalMatches: 0,
          hasMore: false,
          nextCursor: null,
          results: [
            {
              project: { ...project },
              session: { ...sessions[0] },
              matches: [{ field: 'title', snippet: 'Newest session', ranges: [{ start: 0, end: 6 }] }],
              messageMatchCount: 0,
              truncatedMatches: false,
            },
          ],
        }),
      },
      sessionSearchReady: async () => {},
    }).request('/api/project-sessions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Newest', limit: 10 }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionSearchResponseSchema.parse(await response.json())).toEqual({
      query: 'Newest',
      totalSessions: 1,
      totalMatches: 0,
      hasMore: false,
      nextCursor: null,
      results: [
        {
          project: { ...project },
          session: { ...sessions[0], occupiedBy: 'cotta', occupiedStatus: 'busy' },
          matches: [{ field: 'title', snippet: 'Newest session', ranges: [{ start: 0, end: 6 }] }],
          messageMatchCount: 0,
          truncatedMatches: false,
        },
      ],
    })
  })

  it.each([
    ['not-json', 400, 'invalid_cursor'],
    [
      Buffer.from(JSON.stringify({ v: 1, query: 'Other', mode: 'fts', key: { fieldPriority: 0, rank: 0, lastActivityAtMs: 1, messageTimestampMs: -1, sessionId: 's' } })).toString('base64url'),
      409,
      'pagination_cursor_stale',
    ],
  ])('maps search cursor %s to %i', async (cursor, status, error) => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      sessionSearchStore: {
        updateTitle: () => true,
        search: () => {
          throw new ListCursorError(status === 409 ? 'stale' : 'invalid')
        },
      },
      sessionSearchReady: async () => {},
    }).request('/api/project-sessions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Newest', cursor }),
    })

    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })

  it('rejects too-short search queries', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionSearchStore: { updateTitle: () => true, search: () => ({ query: 'x', results: [], totalSessions: 0, totalMatches: 0, hasMore: false, nextCursor: null }) },
      sessionSearchReady: async () => {},
    }).request('/api/project-sessions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'a' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'project_sessions_search_query_too_short' })
  })

  it('returns 400 for invalid search payloads', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionSearchStore: { updateTitle: () => true, search: () => ({ query: 'x', results: [], totalSessions: 0, totalMatches: 0, hasMore: false, nextCursor: null }) },
      sessionSearchReady: async () => {},
    }).request('/api/project-sessions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '', limit: 0 }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_project_sessions_search' })
  })

  it('returns search unavailable when the store is missing', async () => {
    const response = await createTestApp().request('/api/project-sessions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Newest' }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'project_sessions_search_unavailable' })
  })

  it('waits for search readiness before querying', async () => {
    const calls: string[] = []
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
      sessionSearchReady: async () => {
        calls.push('ready')
      },
      sessionSearchStore: {
        updateTitle: () => true,
        search: () => {
          calls.push('search')
          return { query: 'Newest', results: [], totalSessions: 0, totalMatches: 0, hasMore: false, nextCursor: null }
        },
      },
    }).request('/api/project-sessions/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Newest' }),
    })

    expect(response.status).toBe(200)
    expect(calls).toEqual(['ready', 'search'])
  })

  it('returns a selected session summary outside the normal pagination window without changing its cursor', async () => {
    const selected = sessions[1]!
    const selectedSessionDetail = { ...selected, currentCwd: project.path }
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(selected.id, project.id),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions(_projectId, options) {
          return { project, sessions: sessions.slice(0, options?.limit), defaultSessionId: sessions[0]!.id, hasMore: true, nextCursor: sessions[0]!.id }
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [{ projectId: project.id, limit: 1, selectedSessionId: selected.id }] }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({
      sessionsByProject: {
        [project.id]: {
          project,
          sessions: [sessions[0]],
          hasMore: true,
          nextCursor: sessions[0]!.id,
          selectedSessionExists: true,
          selectedSessionDetail,
        },
      },
    })
  })

  it('resolves a selected session by stable id after its requested project disappears', async () => {
    const movedSession = { id: 's1', title: 'Moved', projectId: 'p-new', lastActivityAt: 0, occupiedBy: null, occupiedStatus: 'idle' as const, hasRunningShell: false, kind: null }
    const selectedSessionDetail = { ...movedSession, currentCwd: project.path }
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(movedSession.id, movedSession.projectId, movedSession),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return null
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [{ projectId: 'p-old', limit: 10, selectedSessionId: movedSession.id }] }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({
      sessionsByProject: {
        'p-old': { sessions: [], hasMore: false, nextCursor: null, selectedSessionExists: false, selectedSessionDetail },
      },
    })
  })

  it('does not mark a selected session as existing in the wrong project window', async () => {
    const oldProject = { id: 'p-old', name: 'Old project' }
    const newProject = { id: 'p-new', name: 'New project' }
    const movedSession = { id: 's1', title: 'Moved', projectId: newProject.id, lastActivityAt: 0, occupiedBy: null, occupiedStatus: 'idle' as const, hasRunningShell: false, kind: null }
    const selectedSessionDetail = { ...movedSession, currentCwd: project.path }
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(movedSession.id, movedSession.projectId, movedSession),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [oldProject, newProject], hasMore: false, nextCursor: null }
        },
        async getProject(projectId) {
          return projectId === oldProject.id ? oldProject : projectId === newProject.id ? newProject : null
        },
        async listProjectSessions(projectId) {
          if (projectId === oldProject.id) return { project: oldProject, sessions: [], defaultSessionId: null, hasMore: false, nextCursor: null }
          if (projectId === newProject.id) return { project: newProject, sessions: [movedSession], defaultSessionId: movedSession.id, hasMore: false, nextCursor: null }
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projects: [{ projectId: oldProject.id, limit: 10, selectedSessionId: movedSession.id }],
      }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({
      sessionsByProject: {
        [oldProject.id]: { project: oldProject, sessions: [], hasMore: false, nextCursor: null, selectedSessionExists: false, selectedSessionDetail },
      },
    })
  })

  it('returns empty batch sessions for an empty visible set', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() {
          return { projects: [project], hasMore: false, nextCursor: null }
        },
        async getProject() {
          return project
        },
        async listProjectSessions() {
          return null
        },
        async deleteSession() {
          return false
        },
        async renameSession() {
          return false
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return null
        },
      },
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [] }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({ sessionsByProject: {} })
  })
})
