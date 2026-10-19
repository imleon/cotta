import { COMPOSER_IMAGE_MAX_BYTES, createTurnRequestSchema, type SessionContextUsage } from '@cotta/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../index.js'
import { IndexChangeNotifier } from '../index-change-notifier.js'
import { ProjectDirectoryUnavailableError, SessionTurnInProgressError } from '../live-turn-manager.js'
import { createTestApp, memorySettingsStore, memoryTranscriptIndex, memoryTurnOptionsStore, messages, modelCatalog, project, timelineState } from './project-routes-test-helpers.js'

afterEach(() => vi.restoreAllMocks())

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('project session routes', () => {
  it('publishes a timeline change and syncs existing runtime after updating session turn options', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123)
    const turnOptionsStore = memoryTurnOptionsStore({ 'session-newest': { permissionMode: null, model: 'gateway/my-model', effort: 'high' } })
    const notifier = new IndexChangeNotifier()
    const publishSessionVersion = vi.spyOn(notifier, 'publishSessionVersion')
    const ensureRuntime = vi.fn()
    const syncExistingRuntimeOptions = vi.fn()
    const app = createApp({
      transcriptIndex: memoryTranscriptIndex(),
      turnOptionsStore,
      settingsStore: memorySettingsStore({ modelCatalog, defaultPermissionMode: 'acceptEdits' }),
      indexChangeNotifier: notifier,
      timelineVersionReader: () => 'timeline-canonical-v2',
      liveTurnManager: {
        ensureRuntime,
        syncExistingRuntimeOptions,
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
    })

    const response = await app.request('/api/sessions/session-newest/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    })

    expect(response.status).toBe(200)
    expect(turnOptionsStore.getPrePlanPermissionMode('session-newest')).toBe('acceptEdits')
    expect(turnOptionsStore.observedAtMs).toEqual([123])
    expect(ensureRuntime).not.toHaveBeenCalled()
    expect(syncExistingRuntimeOptions).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', permissionMode: 'plan', model: 'gateway/my-model', effort: 'high' })
    expect(publishSessionVersion).toHaveBeenCalledWith(project.id, 'session-newest', 'timeline-canonical-v2')
  })

  it('does not report success when the turn-options write is rejected', async () => {
    const turnOptionsStore = memoryTurnOptionsStore({ 'session-newest': { permissionMode: 'default', model: null, effort: null } })
    turnOptionsStore.acceptWrites = false
    const app = createTestApp({}, messages, { turnOptionsStore })

    const response = await app.request('/api/sessions/session-newest/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    })

    expect(response.status).toBe(500)
    expect(turnOptionsStore.getSessionTurnOptions('session-newest')?.permissionMode).toBe('default')
  })

  it('keeps persisted turn options successful when runtime sync fails', async () => {
    const turnOptionsStore = memoryTurnOptionsStore({ 'session-newest': { permissionMode: 'default', model: 'gateway/my-model', effort: 'high' } })
    const notifier = new IndexChangeNotifier()
    const publishSessionVersion = vi.spyOn(notifier, 'publishSessionVersion')
    const syncExistingRuntimeOptions = vi.fn().mockRejectedValue(new Error('runtime unavailable'))
    const app = createApp({
      transcriptIndex: memoryTranscriptIndex(),
      turnOptionsStore,
      settingsStore: memorySettingsStore({ modelCatalog }),
      indexChangeNotifier: notifier,
      timelineVersionReader: () => 'timeline-canonical-v2',
      liveTurnManager: {
        ensureRuntime: () => {},
        syncExistingRuntimeOptions,
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
    })

    const response = await app.request('/api/sessions/session-newest/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    })

    expect(response.status).toBe(200)
    expect(turnOptionsStore.getSessionTurnOptions('session-newest')?.permissionMode).toBe('plan')
    expect(syncExistingRuntimeOptions).toHaveBeenCalled()
    expect(publishSessionVersion).toHaveBeenCalledWith(project.id, 'session-newest', 'timeline-canonical-v2')
  })

  it('saves turn options for an unresolved session and syncs by session id', async () => {
    const turnOptionsStore = memoryTurnOptionsStore()
    const syncExistingRuntimeOptions = vi.fn()
    const notifier = new IndexChangeNotifier()
    const publishSessionVersion = vi.spyOn(notifier, 'publishSessionVersion')
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      turnOptionsStore,
      settingsStore: memorySettingsStore({ modelCatalog }),
      indexChangeNotifier: notifier,
      liveTurnManager: {
        ensureRuntime: () => {},
        syncExistingRuntimeOptions,
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
    })

    const response = await app.request('/api/sessions/preseeded/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    })

    expect(response.status).toBe(200)
    expect(turnOptionsStore.getSessionTurnOptions('preseeded')).toEqual({ permissionMode: 'plan', model: null, effort: null })
    expect(syncExistingRuntimeOptions).toHaveBeenCalledWith({ sessionId: 'preseeded', permissionMode: 'plan', model: 'default', effort: 'medium' })
    expect(publishSessionVersion).not.toHaveBeenCalled()
  })

  it('updates session permission independently from model and effort', async () => {
    const turnOptionsStore = memoryTurnOptionsStore({ session: { permissionMode: 'default', model: 'gateway/my-model', effort: 'high' } })
    const app = createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      turnOptionsStore,
      settingsStore: memorySettingsStore({ modelCatalog }),
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
    })

    const permission = await app.request('/api/sessions/session/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'plan' }),
    })
    expect(permission.status).toBe(200)
    expect(turnOptionsStore.getSessionTurnOptions('session')).toEqual({ permissionMode: 'plan', model: 'gateway/my-model', effort: 'high' })

    const pair = await app.request('/api/sessions/session/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-effort-model', effort: 'high' }),
    })
    expect(pair.status).toBe(200)
    expect(turnOptionsStore.getSessionTurnOptions('session')).toEqual({ permissionMode: 'plan', model: 'no-effort-model', effort: null })

    const halfPair = await app.request('/api/sessions/session/turn-options', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gateway/my-model' }),
    })
    expect(halfPair.status).toBe(400)
    expect(await halfPair.json()).toEqual({ error: 'invalid_turn_options_update' })
  })
  it('creates a session with turn options and no turnId', async () => {
    let received: unknown
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async (input) => {
          received = input
          return { sessionId: input.sessionId, userMessageUuid: input.userMessageUuid }
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
      settingsStore: memorySettingsStore({ modelCatalog, defaultPermissionMode: 'plan', defaultModel: 'gateway/my-model', defaultEffort: 'xhigh' }),
      turnOptionsStore: memoryTurnOptionsStore({ '10000000-0000-4000-8000-000000000001': { permissionMode: 'default', model: 'default', effort: 'medium' } }),
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '10000000-0000-4000-8000-000000000001', text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000001' }),
    })

    expect(response.status).toBe(202)
    expect(received).toMatchObject({
      projectId: project.id,
      sessionId: '10000000-0000-4000-8000-000000000001',
      resume: false,
      text: 'hello',
      userMessageUuid: '00000000-0000-4000-8000-000000000001',
      permissionMode: 'default',
      model: 'default',
      effort: 'medium',
    })
    expect(await response.json()).toEqual({
      projectId: project.id,
      sessionId: '10000000-0000-4000-8000-000000000001',
      userMessageUuid: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('passes image-only session turns to the live runtime', async () => {
    let received: unknown
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',
      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async (input) => {
          received = input
          return { sessionId: input.sessionId, userMessageUuid: input.userMessageUuid }
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
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: '10000000-0000-4000-8000-000000000005',
        images: [{ mediaType: 'image/png', data: png }],
        userMessageUuid: '00000000-0000-4000-8000-000000000005',
      }),
    })

    expect(response.status).toBe(202)
    expect(received).toMatchObject({
      projectId: project.id,
      sessionId: '10000000-0000-4000-8000-000000000005',
      resume: false,
      images: [{ mediaType: 'image/png', data: png }],
      userMessageUuid: '00000000-0000-4000-8000-000000000005',
    })
  })

  it('maps atomic foreground turn conflicts to HTTP 409', async () => {
    const response = await createTestApp({}, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new SessionTurnInProgressError()
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
    }).request('/api/sessions/session-newest/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000013' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'session_turn_in_progress' })
  })

  it('rejects new-session turns owned by CLI metadata', async () => {
    const startTurn = vi.fn()
    const response = await createTestApp({}, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn,
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'idle', hasRunningShell: true, kind: null, entrypoint: 'cli' }) },
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '10000000-0000-4000-8000-000000000007', text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000007' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'session_externally_owned' })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('rejects existing-session turns owned by CLI metadata', async () => {
    const startTurn = vi.fn()
    const response = await createTestApp({}, messages, {
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn,
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'busy', hasRunningShell: false, kind: null, entrypoint: 'cli' }) },
    }).request('/api/sessions/session-newest/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000008' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'session_externally_owned' })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('creates an existing-session turn with explicit default model and no effort', async () => {
    let received: unknown
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex('session-newest', 'canonical-project'),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async (input) => {
          received = input
          return { sessionId: input.sessionId ?? 'missing', userMessageUuid: input.userMessageUuid }
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
    }).request('/api/sessions/session-newest/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000002' }),
    })

    expect(response.status).toBe(202)
    expect(received).toMatchObject({
      projectId: 'canonical-project',
      sessionId: 'session-newest',
      resume: true,
      text: 'hello',
      userMessageUuid: '00000000-0000-4000-8000-000000000002',
      permissionMode: 'default',
    })
    expect(await response.json()).toMatchObject({ projectId: 'canonical-project', sessionId: 'session-newest' })
    expect(received).toHaveProperty('model', 'default')
    expect(received).toHaveProperty('effort', 'medium')
  })

  it('accepts exactly 20 MiB of images without fully decoding them during request validation', () => {
    const bytes = Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const data = bytes.toString('base64')
    const decode = vi.spyOn(globalThis, 'atob')

    expect(
      createTurnRequestSchema.safeParse({
        images: Array.from({ length: 4 }, () => ({ mediaType: 'image/png', data })),
        userMessageUuid: '00000000-0000-4000-8000-000000000009',
      }).success,
    ).toBe(true)
    expect(decode.mock.calls).toHaveLength(4)
    expect(decode.mock.calls.every(([value]) => value.length <= 16 && value.length < data.length)).toBe(true)
  })

  it('returns 413 before parsing oversized create-turn JSON on both routes', async () => {
    const app = createTestApp()
    for (const path of [`/api/projects/${project.id}/sessions`, '/api/sessions/session-newest/turns']) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(30 * 1024 * 1024 + 1) },
        body: '{',
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'turn_request_too_large' })
    }
  })

  it('returns 400 for invalid turn request bodies', async () => {
    const cases = [
      { path: `/api/projects/${project.id}/sessions`, body: '{' },
      { path: `/api/projects/${project.id}/sessions`, body: JSON.stringify({ text: '', userMessageUuid: 'not-a-uuid' }) },
      { path: '/api/sessions/session-newest/turns', body: '{' },
      { path: '/api/sessions/session-newest/turns', body: JSON.stringify({ text: '', userMessageUuid: 'not-a-uuid' }) },
      {
        path: '/api/sessions/session-newest/turns',
        body: JSON.stringify({ images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }], userMessageUuid: '00000000-0000-4000-8000-000000000010' }),
      },
      {
        path: '/api/sessions/session-newest/turns',
        body: JSON.stringify({ text: '/compact', images: [{ mediaType: 'image/png', data: png }], userMessageUuid: '00000000-0000-4000-8000-000000000011' }),
      },
      {
        path: '/api/sessions/session-newest/turns',
        body: JSON.stringify({
          images: Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: `iVBORw0KGgoA${'A'.repeat(5_592_396)}` })),
          userMessageUuid: '00000000-0000-4000-8000-000000000012',
        }),
      },
    ]

    for (const input of cases) {
      const response = await createTestApp().request(input.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: input.body,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_turn_request' })
    }
  })

  it('returns a conflict when starting a turn without its project directory', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new ProjectDirectoryUnavailableError()
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
    }).request('/api/sessions/session-newest/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000002' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'project_directory_unavailable' })
  })

  it('rejects a body session id that differs from the existing-session path', async () => {
    const response = await createTestApp().request('/api/sessions/session-newest/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '10000000-0000-4000-8000-000000000099', text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000099' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'session_id_mismatch' })
  })

  it('returns not found when creating a turn for an unknown session', async () => {
    const response = await createTestApp().request('/api/sessions/session-missing/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000099' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it('passes explicit default model and omits effort', async () => {
    let received: unknown
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async (input) => {
          received = input
          return { sessionId: input.sessionId ?? 'session-new', userMessageUuid: input.userMessageUuid }
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
      settingsStore: memorySettingsStore({ modelCatalog }),
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '10000000-0000-4000-8000-000000000006', text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000006', model: 'default', effort: 'default' }),
    })

    expect(response.status).toBe(202)
    expect(received).toMatchObject({
      projectId: project.id,
      text: 'hello',
      userMessageUuid: '00000000-0000-4000-8000-000000000006',
      permissionMode: 'default',
    })
    expect(received).toHaveProperty('model', 'default')
    expect(received).toHaveProperty('effort', 'medium')
  })

  it('rejects unsupported turn model', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('should not start')
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
      settingsStore: memorySettingsStore({ modelCatalog, defaultModel: 'gateway/my-model', defaultEffort: 'medium' }),
      turnOptionsStore: memoryTurnOptionsStore({ '10000000-0000-4000-8000-000000000003': { permissionMode: 'default', model: 'missing-model', effort: 'medium' } }),
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '10000000-0000-4000-8000-000000000003', text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000003' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'unsupported_model' })
  })

  it('rejects unsupported turn effort', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('should not start')
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
      settingsStore: memorySettingsStore({ modelCatalog, defaultModel: 'gateway/my-model', defaultEffort: 'medium' }),
      turnOptionsStore: memoryTurnOptionsStore({ '10000000-0000-4000-8000-000000000004': { permissionMode: 'default', model: 'no-effort-model', effort: 'high' } }),
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: '10000000-0000-4000-8000-000000000004', text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000004' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'unsupported_effort' })
  })

  it('closes but does not rebuild a runtime owned by an active CLI session', async () => {
    const restartRuntime = vi.fn().mockResolvedValue(false)
    const response = await createApp({
      timelineVersionReader: () => 'timeline-canonical-v2',
      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        hasRuntime: () => true,
        restartRuntime,
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
      claudeSessionRegistry: { cliSessionMetadata: () => ({ status: 'busy', hasRunningShell: false, kind: null, entrypoint: 'cli' }) },
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
    }).request('/api/sessions/session-newest/restart', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, restarted: false })
    expect(restartRuntime).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', permissionMode: 'default', rebuild: false })
  })

  it('interrupts a session without a turn id', async () => {
    let interruptedSessionId: string | null = null
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
        interrupt: async (sessionId) => {
          interruptedSessionId = sessionId
          return true
        },
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
    }).request('/api/sessions/session-newest/interrupt', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ interrupted: true })
    expect(interruptedSessionId).toBe('session-newest')
  })
  it('deletes an existing session after confirming the session id', async () => {
    const calls: string[] = []
    const closeForExternalOwner = vi.fn(async () => {
      calls.push('closeForExternalOwner')
      return true
    })
    const remove = vi.fn(async () => {
      calls.push('deleteSession')
      return true
    })
    const clearRuntimeTurnProjection = vi.fn(() => {
      calls.push('clearRuntimeTurnProjection')
    })
    const syncTranscriptIndex = vi.fn(async () => {
      calls.push('syncTranscriptIndex')
    })
    const publishChange = vi.fn(() => {
      calls.push('publishChange')
    })
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => null,
        runtimeTurnProjection: () => null,
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
        closeForExternalOwner,
        clearRuntimeTurnProjection,
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
        deleteSession: remove,
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
    }).request(`/api/projects/${project.id}/sessions/session-newest/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationSessionId: 'session-newest' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(closeForExternalOwner).toHaveBeenCalledWith('session-newest', 'Session was interrupted because it was deleted.', { rebuildAfterCliIdle: false })
    expect(remove).toHaveBeenCalledWith(project.id, 'session-newest')
    expect(clearRuntimeTurnProjection).toHaveBeenCalledWith('session-newest')
    expect(syncTranscriptIndex).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', kind: 'removed' })
    expect(publishChange).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', kind: 'removed' })
    expect(calls).toEqual(['closeForExternalOwner', 'deleteSession', 'clearRuntimeTurnProjection', 'syncTranscriptIndex', 'publishChange'])
  })

  it('re-resolves transcript ownership before deleting', async () => {
    const initialIndex = memoryTranscriptIndex()
    let session = initialIndex.getSession('session-newest')!
    const transcriptSyncer = vi.fn(async () => {
      session = { ...session, currentProjectId: 'project-moved' }
    })
    const remove = vi.fn(async () => true)
    const response = await createTestApp({}, messages, {
      transcriptIndex: { getSession: (sessionId) => (sessionId === 'session-newest' ? session : null) },
      transcriptSyncer,
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
        deleteSession: remove,
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
    }).request(`/api/projects/${project.id}/sessions/session-newest/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationSessionId: 'session-newest' }),
    })

    expect(response.status).toBe(404)
    expect(transcriptSyncer).toHaveBeenCalledWith(project.id, 'session-newest', timelineState.fileSize)
    expect(remove).not.toHaveBeenCalled()
  })

  it('reports when deletion fails after interrupting the running turn', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionRunState: () => ({ phase: 'running', activeUserMessageUuid: 'user-1', lastTurn: null }),
        runtimeTurnProjection: () => null,
        clearRuntimeTurnProjection: () => {},
        startTurn: async () => {
          throw new Error('not implemented')
        },
        acknowledgeCompletedTurn: () => false,
        interrupt: async () => false,
        subscribe: () => () => {},
        closeForExternalOwner: async () => true,
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
    }).request(`/api/projects/${project.id}/sessions/session-newest/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationSessionId: 'session-newest' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found_after_interrupt' })
  })

  it('rejects a mismatched session delete confirmation', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions/session-newest/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationSessionId: 'wrong' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_session_delete_confirmation' })
  })

  it('returns 404 when deleting an unknown session before closing runtime', async () => {
    const closeForExternalOwner = vi.fn(async () => true)
    const remove = vi.fn(async () => true)
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
        closeForExternalOwner,
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
        deleteSession: remove,
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
    }).request(`/api/projects/${project.id}/sessions/missing/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationSessionId: 'missing' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
    expect(closeForExternalOwner).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(syncTranscriptIndex).not.toHaveBeenCalled()
    expect(publishChange).not.toHaveBeenCalled()
  })

  it('renames an existing session', async () => {
    const rename = vi.fn(async () => true)
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
        renameSession: rename,
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
    }).request(`/api/projects/${project.id}/sessions/session-newest/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(rename).toHaveBeenCalledWith(project.id, 'session-newest', 'New title')
    expect(syncTranscriptIndex).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', kind: 'changed' })
    expect(publishChange).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'session-newest', kind: 'changed' })
  })

  it('rejects an empty session title', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions/session-newest/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_session_title' })
  })

  it('returns 404 when renaming an unknown session', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions/missing/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it.each(['none', 'search missing', 'search throws', 'sync', 'publish', 'all', 'sdk missing', 'sdk throws'] as const)(
    'keeps the authoritative rename result when post-processing fails: %s',
    async (failure) => {
      const calls: string[] = []
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const error = new Error('injected failure')
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
            calls.push('rename')
            if (failure === 'sdk throws') throw error
            return failure !== 'sdk missing'
          },
          async forkSession() {
            return null
          },
          async getSessionTimelineState() {
            return null
          },
        },
        sessionSearchStore: {
          search: () => ({ query: '', results: [], totalSessions: 0, totalMatches: 0, hasMore: false, nextCursor: null }),
          updateTitle: (sessionId, title) => {
            calls.push(`search:${sessionId}:${title}`)
            if (failure === 'search throws' || failure === 'all') throw error
            return failure !== 'search missing'
          },
        },
        syncTranscriptIndex: async (input) => {
          calls.push(`sync:${input?.kind}:${input?.sessionId}`)
          if (failure === 'sync' || failure === 'all') throw error
        },
        indexChangeNotifier: {
          versionSnapshot: { epoch: '123e4567-e89b-12d3-a456-426614174000', projectsVersion: 0, projectVersions: [], sessionVersions: [], subagentVersions: [], sessionChanges: [] },
          subscribe: () => () => {},
          publishChange: () => {
            calls.push('publish')
            if (failure === 'publish' || failure === 'all') throw error
          },
        },
      }).request(`/api/projects/${project.id}/sessions/session-newest/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      })

      if (failure === 'sdk missing' || failure === 'sdk throws') {
        expect(response.status).toBe(failure === 'sdk missing' ? 404 : 500)
        expect(await response.json()).toEqual({ error: failure === 'sdk missing' ? 'session_not_found' : 'session_rename_failed' })
        expect(calls).toEqual(['rename'])
        expect(log).toHaveBeenCalledTimes(failure === 'sdk missing' ? 0 : 1)
        return
      }
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(calls).toEqual(['rename', 'search:session-newest:New title', 'sync:changed:session-newest', 'publish'])
      const expectedLogs = [
        ...(['search missing', 'search throws', 'all'].includes(failure) ? ['session:rename search index update failed'] : []),
        ...(['sync', 'all'].includes(failure) ? ['session:rename index sync failed'] : []),
        ...(['publish', 'all'].includes(failure) ? ['session:rename notification failed'] : []),
      ]
      expect(log.mock.calls.map(([label]) => label)).toEqual(expectedLogs)
      for (const [, sessionId] of log.mock.calls) expect(sessionId).toBe('session-newest')
      expect(log.mock.calls.flat()).not.toContain('New title')
    },
  )

  it('forks an existing session at an opaque SDK message id', async () => {
    const syncTranscriptIndex = vi.fn(async () => {})
    const publishChange = vi.fn()
    const fork = vi.fn(async () => 'fork-session')
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
        forkSession: fork,
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
    }).request(`/api/projects/${project.id}/sessions/session-newest/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upToMessageId: 'assistant-response-42' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ projectId: project.id, sessionId: 'fork-session' })
    expect(fork).toHaveBeenCalledWith(project.id, 'session-newest', 'assistant-response-42')
    expect(syncTranscriptIndex).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'fork-session', kind: 'changed' })
    expect(publishChange).toHaveBeenCalledWith({ projectId: project.id, sessionId: 'fork-session', kind: 'changed' })
  })

  it('forks a whole session when no fork target is provided', async () => {
    const fork = vi.fn(async () => 'fork-session')
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
        forkSession: fork,
        async getSessionTimelineState() {
          return null
        },
      },
    }).request(`/api/projects/${project.id}/sessions/session-newest/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ projectId: project.id, sessionId: 'fork-session' })
    expect(fork).toHaveBeenCalledWith(project.id, 'session-newest', undefined)
  })

  it('rejects an empty fork target', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions/session-newest/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upToMessageId: '' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_fork_target' })
  })

  it('returns 404 when forking an unknown session', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions/missing/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upToMessageId: '123e4567-e89b-12d3-a456-426614174000' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it('rejects unsupported runtime effort', async () => {
    let ensured = false
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {
          ensured = true
        },
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
          return true
        },
        async renameSession() {
          return true
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return timelineState
        },
      },
      settingsStore: memorySettingsStore({ modelCatalog }),
      turnOptionsStore: memoryTurnOptionsStore({ 'session-newest': { permissionMode: 'default', model: 'no-effort-model', effort: 'high' } }),
    }).request('/api/sessions/session-newest/runtime', { method: 'POST' })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'unsupported_effort' })
    expect(ensured).toBe(false)
  })

  it('ensures runtime when ownership is available with no CLI metadata', async () => {
    let ensured: unknown
    const initializationResult = { models: [{ value: 'model-a' }], product: { source: 'sdk-init', flags: ['full'] } }
    const contextUsage = {
      model: 'model-a',
      categories: [{ name: 'Messages', tokens: 120, kind: 'used' }],
      totalTokens: 120,
      autoCompactThreshold: 160000,
      maxTokens: 200000,
      percentage: 0.06,
      updatedAtMs: 123,
    } satisfies SessionContextUsage
    const readContextUsage = vi.fn(async () => contextUsage)
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: (input) => {
          ensured = input
          return initializationResult
        },
        contextUsage: readContextUsage,
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
          return true
        },
        async renameSession() {
          return true
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return timelineState
        },
      },
    }).request('/api/sessions/session-newest/runtime', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(ensured).toMatchObject({ projectId: project.id, sessionId: 'session-newest', permissionMode: 'default' })
    expect(ensured).toHaveProperty('model', 'default')
    expect(ensured).toHaveProperty('effort', 'medium')
    expect(readContextUsage).toHaveBeenCalledWith('session-newest', true)
    expect(await response.json()).toEqual({
      ok: true,
      projectId: project.id,
      sessionId: 'session-newest',
      settings: { permissionMode: 'default', model: 'default', effort: 'medium' },
      initializationResult,
      contextUsage,
    })
  })

  it('re-resolves transcript ownership before initializing runtime', async () => {
    const initialIndex = memoryTranscriptIndex()
    let session = initialIndex.getSession('session-newest')!
    const transcriptSyncer = vi.fn(async () => {
      session = { ...session, currentProjectId: 'project-moved' }
    })
    const ensureRuntime = vi.fn()
    const response = await createTestApp({}, messages, {
      transcriptIndex: { getSession: (sessionId) => (sessionId === 'session-newest' ? session : null) },
      transcriptSyncer,
      liveTurnManager: {
        ensureRuntime,
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
    }).request('/api/sessions/session-newest/runtime', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(transcriptSyncer).toHaveBeenCalledWith(project.id, 'session-newest', timelineState.fileSize)
    expect(ensureRuntime).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-moved', sessionId: 'session-newest' }))
  })

  it('returns a conflict when the project directory is unavailable', async () => {
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {
          throw new ProjectDirectoryUnavailableError()
        },
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
          return true
        },
        async renameSession() {
          return true
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return timelineState
        },
      },
    }).request('/api/sessions/session-newest/runtime', { method: 'POST' })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'project_directory_unavailable' })
  })

  it('skips runtime ensure for background CLI sessions', async () => {
    let ensured = false
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {
          ensured = true
        },
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
          return true
        },
        async renameSession() {
          return true
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return timelineState
        },
      },
      claudeSessionRegistry: {
        cliSessionMetadata: () => ({ status: 'idle', hasRunningShell: false, kind: 'bg', entrypoint: 'cli' }),
      },
    }).request('/api/sessions/session-newest/runtime', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(ensured).toBe(false)
    expect(await response.json()).toMatchObject({ initializationResult: null })
  })

  it('does not ensure runtime for CLI idle sessions with a background shell', async () => {
    let ensured = false
    const response = await createApp({
      timelineVersionReader: () => 'timeline-missing',

      transcriptIndex: memoryTranscriptIndex(),
      liveTurnManager: {
        ensureRuntime: () => {
          ensured = true
        },
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
          return true
        },
        async renameSession() {
          return true
        },
        async forkSession() {
          return null
        },
        async getSessionTimelineState() {
          return timelineState
        },
      },
      claudeSessionRegistry: {
        cliSessionMetadata: () => ({ status: 'idle', hasRunningShell: true, kind: null, entrypoint: 'cli' }),
      },
    }).request('/api/sessions/session-newest/runtime', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(ensured).toBe(false)
    expect(await response.json()).toMatchObject({ initializationResult: null })
  })

  it('returns 404 when ensuring runtime for an unknown session', async () => {
    const response = await createTestApp().request('/api/sessions/missing/runtime', { method: 'POST' })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it('does not expose the old project-bound runtime route', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}/sessions/session-newest/runtime`, { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('answers pending tool approvals', async () => {
    const answer = vi.fn(() => ({ status: 'answered' as const }))
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
        respondToPermission: answer,
      },
    }).request('/api/sessions/session-live/permissions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(answer).toHaveBeenCalledWith('session-live', 'req-1', { decision: 'allow' })
  })

  it('answers pending user questions', async () => {
    const answer = vi.fn(() => ({ status: 'answered' as const }))
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
        respondToQuestion: answer,
      },
    })
    const decision = { behavior: 'completed', toolUseID: 'tool-1', answers: { 'Ship?': 'API, observability, logs' }, annotations: { 'Ship?': { preview: 'release', notes: 'today' } } }
    const response = await app.request('/api/sessions/session-live/questions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decision),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(answer).toHaveBeenCalledWith('session-live', 'req-1', decision)
  })

  it('rejects invalid and stale question decisions', async () => {
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
        respondToQuestion: () => null,
      },
    })
    const invalid = await app.request('/api/sessions/session-live/questions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior: 'completed', updatedInput: {} }),
    })
    const stale = await app.request('/api/sessions/session-live/questions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior: 'cancelled', toolUseID: 'tool-1' }),
    })

    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_question_decision' })
    expect(stale.status).toBe(404)
    expect(await stale.json()).toEqual({ error: 'question_request_not_found' })
  })

  it('does not persist predicted permission mode before the SDK confirms it', async () => {
    const turnOptionsStore = memoryTurnOptionsStore()
    const notifier = new IndexChangeNotifier()
    const publishChange = vi.spyOn(notifier, 'publishChange')
    const response = await createApp({
      transcriptIndex: memoryTranscriptIndex(),
      turnOptionsStore,
      indexChangeNotifier: notifier,
      timelineVersionReader: () => 'timeline-canonical-v2',
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
        respondToPermission: () => ({ status: 'answered' }),
      },
    }).request('/api/sessions/session-newest/permissions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow_suggestion' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(turnOptionsStore.getSessionTurnOptions('session-newest')).toBeNull()
    expect(publishChange).not.toHaveBeenCalled()
  })

  it('returns 400 for obsolete SDK-shaped permission decisions', async () => {
    const answer = vi.fn()
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
        respondToPermission: answer,
      },
    }).request('/api/sessions/session-live/permissions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' }] }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_permission_decision' })
    expect(answer).not.toHaveBeenCalled()
  })

  it('returns 404 for stale tool approvals', async () => {
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
        respondToPermission: () => null,
      },
    }).request('/api/sessions/session-live/permissions/req-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'permission_request_not_found' })
  })
})
