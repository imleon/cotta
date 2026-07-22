import { describe, expect, it } from 'vitest'
import {
  projectResponseSchema,
  projectSessionsQueryResponseSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  sessionLiveEventsResponseSchema,
  sessionRawMessagesResponseSchema,
  sessionTimelineResponseSchema,
  sessionTimelineStateResponseSchema,
  type PersistedLiveEvent,
  type ProjectSummary,
  type SessionSummary,
  type SessionTimelineState,
} from '@cotta/shared'
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { createApp } from '../index.js'

const project: ProjectSummary = {
  id: 'project-one',
  name: 'cotta-v2',
  path: '/tmp/cotta-v2',
  lastActivityAt: 123,
}

const sessions: SessionSummary[] = [
  {
    id: 'session-newest',
    projectId: project.id,
    title: 'Newest session',
    lastActivityAt: 123,
  },
  {
    id: 'session-older',
    projectId: project.id,
    title: 'Older session',
    lastActivityAt: 100,
  },
]

const timelineState: SessionTimelineState = {
  projectId: project.id,
  sessionId: 'session-newest',
  version: 'timeline-state-v1:mtime=123;size=456',
  signature: 'mtime=123;size=456',
  lastActivityAt: 123,
  fileSize: 456,
  generatedAt: 789,
}

type TimestampedSessionMessage = SessionMessage & { timestamp?: string }

const messages: TimestampedSessionMessage[] = [
  {
    type: 'user',
    uuid: 'user-1',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:00:00.000Z',
    message: { role: 'user', content: 'First prompt' },
  },
  {
    type: 'assistant',
    uuid: 'assistant-1',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:00:10.000Z',
    message: {
      id: 'msg_assistant_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'First answer' }],
    },
  },
  {
    type: 'user',
    uuid: 'user-2',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:00.000Z',
    message: { role: 'user', content: 'Second prompt' },
  },
  {
    type: 'assistant',
    uuid: 'assistant-2',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:15.000Z',
    message: {
      id: 'msg_assistant_2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking the file' },
        { type: 'tool_use', id: 'toolu_123', name: 'Read', input: { file_path: '/tmp/example.ts' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'task-notification-1',
    session_id: 'session-newest',
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:20.000Z',
    message: {
      role: 'user',
      content: '<task-notification>\n<task-id>task_123</task-id>\n<tool-use-id>call_123</tool-use-id>\n<output-file>/tmp/task.output</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>## Done\n\n- Found issue\n- Fixed issue</result>\n</task-notification>',
    },
  },
  {
    type: 'user',
    uuid: 'tool-result-1',
    session_id: 'session-newest',
    parent_tool_use_id: 'toolu_123',
    parent_agent_id: null,
    timestamp: '2026-07-14T08:01:30.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_123', content: 'file contents' }],
    },
  },
]

function createTestApp(
  liveStates: Record<string, 'running' | 'requires_action'> = {},
  sessionMessages: TimestampedSessionMessage[] = messages,
  liveEvents: PersistedLiveEvent[] = [],
) {
  return createApp({
    liveTurnManager: {
      ensureRuntime: () => {},
      sessionState: (sessionId) => liveStates[sessionId] ?? null,
      startTurn: async () => { throw new Error('not implemented') },
      interrupt: async () => false,
      subscribe: () => () => {},
    },
    liveEventStore: {
      append() {},
      listSessionEvents(projectId, sessionId) {
        return liveEvents.filter((event) => event.projectId === projectId && event.sessionId === sessionId)
      },
    },
    claudeCodeApi: {
      async listProjects() {
        return { projects: [project], hasMore: false, nextCursor: null }
      },
      async getProject(projectId) {
        return projectId === project.id ? project : null
      },
      async listProjectSessions(projectId, options = {}) {
        if (projectId !== project.id) return null
        const limit = options.limit ?? sessions.length
        const cursorIndex = options.cursor ? sessions.findIndex((session) => session.id === options.cursor) : -1
        const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
        const page = sessions.slice(start, start + limit)
        const hasMore = start + limit < sessions.length
        return {
          project: { ...project },
          sessions: page,
          defaultSessionId: sessions[0]?.id ?? null,
          hasMore,
          nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
        }
      },
      async getSessionTimelineState(projectId, sessionId) {
        if (projectId !== project.id || sessionId !== 'session-newest') return null
        return timelineState
      },
      async getSessionMessages(projectId, sessionId) {
        if (projectId !== project.id || sessionId !== 'session-newest') return null
        return sessionMessages
      },
    },
  })
}

describe('project routes', () => {
  it('lists projects from the Claude Code API adapter', async () => {
    const response = await createTestApp().request('/api/projects')

    expect(response.status).toBe(200)
    expect(projectsResponseSchema.parse(await response.json())).toEqual({ projects: [project], hasMore: false, nextCursor: null })
  })

  it('allows project windows larger than 100', async () => {
    let receivedLimit: number | undefined
    const response = await createApp({
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionState: () => null,
        startTurn: async () => { throw new Error('not implemented') },
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects(options) { receivedLimit = options?.limit; return { projects: [], hasMore: false, nextCursor: null } },
        async getProject() { return null },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
    }).request('/api/projects?limit=101')

    expect(response.status).toBe(200)
    expect(receivedLimit).toBe(101)
  })

  it('gets a project by id', async () => {
    const response = await createTestApp().request(`/api/projects/${project.id}`)

    expect(response.status).toBe(200)
    expect(projectResponseSchema.parse(await response.json())).toEqual({ project })
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

  it('overlays live session status on project sessions', async () => {
    const response = await createTestApp({ 'session-newest': 'running', 'session-older': 'requires_action' }).request(`/api/projects/${project.id}/sessions`)

    expect(response.status).toBe(200)
    expect(projectSessionsResponseSchema.parse(await response.json())).toEqual({
      project: { ...project },
      sessions: [
        { ...sessions[0], rawStatus: 'running', displayStatus: 'running' },
        { ...sessions[1], rawStatus: 'requires_action', displayStatus: 'requires_action' },
      ],
      defaultSessionId: 'session-newest',
      hasMore: false,
      nextCursor: null,
    })
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

  it('returns batch project sessions for requested projects only', async () => {
    const response = await createApp({
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionState: (sessionId) => sessionId === 'session-newest' ? 'running' : null,
        startTurn: async () => { throw new Error('not implemented') },
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() { return { projects: [project], hasMore: false, nextCursor: null } },
        async getProject() { return project },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
      sessionSummaryCache: {
        subscribe: () => () => {},
        scheduleRefresh: async () => {},
        ensureReady: async () => {},
        setSessionStateReader: () => {},
        queryProjectSessions: () => ({
          sessionsByProject: {
            [project.id]: {
              sessions: [{ ...sessions[0], rawStatus: 'running', displayStatus: 'running' }, sessions[1]],
              hasMore: false,
              nextCursor: null,
            },
          },
        }),
      } as never,
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [{ projectId: project.id, limit: 2 }, { projectId: 'missing', limit: 1 }] }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({
      sessionsByProject: {
        [project.id]: {
          sessions: [{ ...sessions[0], rawStatus: 'running', displayStatus: 'running' }, sessions[1]],
          hasMore: false,
          nextCursor: null,
        },
      },
    })
  })

  it('returns empty batch sessions for an empty visible set', async () => {
    const response = await createApp({
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionState: () => null,
        startTurn: async () => { throw new Error('not implemented') },
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() { return { projects: [project], hasMore: false, nextCursor: null } },
        async getProject() { return project },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
      sessionSummaryCache: {
        ensureReady: async () => {},
        setSessionStateReader: () => {},
        subscribe: () => () => {},
        scheduleRefresh: async () => {},
        queryProjectSessions: () => ({ sessionsByProject: {} }),
      } as never,
    }).request('/api/project-sessions/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [] }),
    })

    expect(response.status).toBe(200)
    expect(projectSessionsQueryResponseSchema.parse(await response.json())).toEqual({ sessionsByProject: {} })
  })

  it('creates a session with userMessageUuid and no turnId', async () => {
    const response = await createApp({
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionState: () => null,
        startTurn: async ({ userMessageUuid }) => ({ sessionId: 'session-new', userMessageUuid }),
        interrupt: async () => false,
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() { return { projects: [project], hasMore: false, nextCursor: null } },
        async getProject() { return project },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
    }).request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', userMessageUuid: '00000000-0000-4000-8000-000000000001' }),
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      projectId: project.id,
      sessionId: 'session-new',
      userMessageUuid: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('interrupts a session without a turn id', async () => {
    let interruptedSessionId: string | null = null
    const response = await createApp({
      liveTurnManager: {
        ensureRuntime: () => {},
        sessionState: () => null,
        startTurn: async () => { throw new Error('not implemented') },
        interrupt: async (sessionId) => { interruptedSessionId = sessionId; return true },
        subscribe: () => () => {},
      },
      claudeCodeApi: {
        async listProjects() { return { projects: [project], hasMore: false, nextCursor: null } },
        async getProject() { return project },
        async listProjectSessions() { return null },
        async getSessionTimelineState() { return null },
        async getSessionMessages() { return null },
      },
    }).request(`/api/projects/${project.id}/sessions/session-newest/interrupt`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ interrupted: true })
    expect(interruptedSessionId).toBe('session-newest')
  })

  it('returns a turn-based timeline page for a session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/session-newest/timeline?limitTurns=1`,
    )

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.sessionId).toBe('session-newest')
    expect(body.turns).toHaveLength(1)
    expect(body.turns[0]?.id).toBe('user-2')
    expect(body.turns[0]?.startedAt).toBe(Date.parse('2026-07-14T08:01:00.000Z'))
    expect(body.turns[0]?.completedAt).toBe(Date.parse('2026-07-14T08:01:30.000Z'))
    expect(body.turns[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'assistant-2:assistant:0',
        kind: 'assistant.text',
        apiMessageId: 'msg_assistant_2',
        data: expect.objectContaining({ text: 'Checking the file' }),
      }),
      expect.objectContaining({
        id: 'assistant-2:assistant:1',
        kind: 'assistant.tool_use',
        apiMessageId: 'msg_assistant_2',
        contentBlockId: 'toolu_123',
        toolUseId: 'toolu_123',
        data: expect.objectContaining({ id: 'toolu_123', name: 'Read' }),
      }),
      expect.objectContaining({
        id: 'task-notification-1:task_notification',
        kind: 'assistant.task_notification',
        data: expect.objectContaining({
          taskId: 'task_123',
          toolUseId: 'call_123',
          outputFile: '/tmp/task.output',
          status: 'completed',
          summary: 'Agent finished',
          result: '## Done\n\n- Found issue\n- Fixed issue',
        }),
      }),
      expect.objectContaining({
        id: 'tool-result-1:tool_result:0',
        kind: 'tool.result',
        toolUseId: 'toolu_123',
        data: expect.objectContaining({ tool_use_id: 'toolu_123', content: 'file contents' }),
      }),
    ]))
    expect(body.turns[0]?.blocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'task-notification-1:user',
        kind: 'user.message',
      }),
    ]))
    expect(body.hasMore).toBe(true)
    expect(body.nextCursor).toBe('user-2')
    expect(body.state).toEqual(timelineState)
  })

  it('keeps user-authored task-notification wrappers as user messages', async () => {
    const literalTaskTagMessages: TimestampedSessionMessage[] = [{
      type: 'user',
      uuid: 'literal-task-tag-user',
      session_id: 'session-newest',
      parent_tool_use_id: null,
      parent_agent_id: null,
      timestamp: '2026-07-14T08:02:00.000Z',
      message: { role: 'user', content: '<task-notification>...</task-notification>' },
    }]
    const response = await createTestApp({}, literalTaskTagMessages).request(
      `/api/projects/${project.id}/sessions/session-newest/timeline`,
    )

    expect(response.status).toBe(200)
    const body = sessionTimelineResponseSchema.parse(await response.json())
    expect(body.turns).toHaveLength(1)
    expect(body.turns[0]?.id).toBe('literal-task-tag-user')
    expect(body.turns[0]?.blocks).toEqual([expect.objectContaining({
      id: 'literal-task-tag-user:user',
      kind: 'user.message',
      data: expect.objectContaining({ text: '<task-notification>...</task-notification>' }),
    })])
  })

  it('returns timeline state for a session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/session-newest/timeline/state`,
    )

    expect(response.status).toBe(200)
    expect(sessionTimelineStateResponseSchema.parse(await response.json())).toEqual({ state: timelineState })
  })

  it('returns 404 for timeline state of an unknown session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/missing/timeline/state`,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it('ensures runtime for an existing session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/session-newest/runtime`,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('returns 404 when ensuring runtime for an unknown session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/missing/runtime`,
      { method: 'POST' },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it('returns captured live events for a session', async () => {
    const liveEvents: PersistedLiveEvent[] = [
      {
        id: 1,
        projectId: project.id,
        sessionId: 'session-newest',
        eventType: 'system',
        source: 'sdk',
        recordedAtMs: 1,
        payload: { type: 'system', subtype: 'session_state_changed', state: 'running' },
      },
      {
        id: 2,
        projectId: project.id,
        sessionId: 'session-older',
        eventType: 'result',
        source: 'sdk',
        recordedAtMs: 2,
        payload: { type: 'result', subtype: 'success' },
      },
    ]
    const response = await createTestApp({}, messages, liveEvents).request(
      `/api/projects/${project.id}/sessions/session-newest/live-events`,
    )

    expect(response.status).toBe(200)
    expect(sessionLiveEventsResponseSchema.parse(await response.json())).toEqual({
      sessionId: 'session-newest',
      events: [liveEvents[0]],
    })
  })

  it('returns captured live events from the product route alias', async () => {
    const liveEvents: PersistedLiveEvent[] = [{
      id: 1,
      projectId: project.id,
      sessionId: 'session-newest',
      eventType: 'system',
      source: 'sdk',
      recordedAtMs: 1,
      payload: { type: 'system', subtype: 'session_state_changed', state: 'running' },
    }]
    const response = await createTestApp({}, messages, liveEvents).request(
      `/api/projects/${project.id}/live-sessions/session-newest/events`,
    )

    expect(response.status).toBe(200)
    expect(sessionLiveEventsResponseSchema.parse(await response.json())).toEqual({
      sessionId: 'session-newest',
      events: liveEvents,
    })
  })

  it('returns 404 for live events of an unknown session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/missing/live-events`,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })

  it('returns raw messages for a session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/session-newest/raw-messages`,
    )

    expect(response.status).toBe(200)
    expect(sessionRawMessagesResponseSchema.parse(await response.json())).toEqual({
      sessionId: 'session-newest',
      messages,
    })
  })

  it('returns 404 for raw messages of an unknown session', async () => {
    const response = await createTestApp().request(
      `/api/projects/${project.id}/sessions/missing/raw-messages`,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'session_not_found' })
  })
})
