import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  type ModelCatalogResponse,
  type ProjectSummary,
  type SessionRawTranscriptLine,
  type SessionRunState,
  type SessionSummary,
  type SessionTimelineState,
  timelineLocalCommand,
} from '@cotta/shared'
import { createApp } from '../index.js'
import { TimelineAnchorStaleError } from '../session-raw-transcript-cache.js'
import type { TranscriptIndexStore } from '../transcript-index-store.js'
import { materializeTranscriptTurnOwnership } from '../transcript-turn-ownership.js'

export const project: ProjectSummary = {
  id: 'project-one',
  name: 'cotta-v2',
  path: '/tmp/cotta-v2',
  lastActivityAt: 123,
}

export const modelCatalog: ModelCatalogResponse = {
  models: [
    { value: 'default', displayName: 'Claude Code default', description: 'Use the Claude Code default model.', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    {
      value: 'gateway/my-model',
      resolvedModel: 'gateway/my-model',
      displayName: 'Gateway model',
      description: 'Gateway model discovered by Claude Code.',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'no-effort-model',
      displayName: 'No effort model',
      description: 'Model without effort controls.',
      supportsEffort: false,
      supportedEffortLevels: [],
    },
  ],
}

export const sessions: SessionSummary[] = [
  {
    id: 'session-newest',
    projectId: project.id,
    title: 'Newest session',
    lastActivityAt: 123,
    occupiedBy: null,
    occupiedStatus: 'idle',
    hasRunningShell: false,
    kind: null,
  },
  {
    id: 'session-older',
    projectId: project.id,
    title: 'Older session',
    lastActivityAt: 100,
    occupiedBy: null,
    occupiedStatus: 'idle',
    hasRunningShell: false,
    kind: null,
  },
]

export const timelineState: SessionTimelineState = {
  sessionId: 'session-newest',
  version: 'timeline-state-v1:mtime=123;size=456',
  fileSize: 456,
}

export type TimestampedSessionMessage = SessionMessage & { timestamp?: string }

export const messages: TimestampedSessionMessage[] = [
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
    origin: { kind: 'task-notification' },
    timestamp: '2026-07-14T08:01:20.000Z',
    message: {
      role: 'user',
      content:
        '<task-notification>\n<task-id>task_123</task-id>\n<tool-use-id>call_123</tool-use-id>\n<output-file>/tmp/task.output</output-file>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>## Done\n\n- Found issue\n- Fixed issue</result>\n</task-notification>',
    },
  } as unknown as TimestampedSessionMessage,
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

function buildRawLines(sessionMessages: TimestampedSessionMessage[]): SessionRawTranscriptLine[] {
  const lines = sessionMessages.map((message, index) => {
    const cwd = 'cwd' in message && typeof message.cwd === 'string' ? message.cwd : null
    return {
      session_id: 'session-newest',
      byte_offset: index * 100,
      byte_length: 100,
      line_no: index + 1,
      uuid: message.uuid,
      type: message.type,
      timestamp_ms: message.timestamp ? Date.parse(message.timestamp) : null,
      parent_uuid: null,
      is_sidechain: null,
      user_type: null,
      entrypoint: null,
      cwd,
      version: null,
      git_branch: null,
      owner_turn_id: null,
      raw_json: JSON.stringify(message),
      created_at_ms: 1,
    }
  })
  const owners = new Map(materializeTranscriptTurnOwnership(lines).map((line) => [line.byte_offset, line.owner_turn_id]))
  return lines.map((line) => ({ ...line, owner_turn_id: owners.get(line.byte_offset) ?? null }))
}

export const rawLines = buildRawLines(messages)

function rawLinesForTurn(lines: SessionRawTranscriptLine[], turnId: string): SessionRawTranscriptLine[] | null {
  const owned = lines.filter((line) => line.owner_turn_id === turnId)
  return owned.length ? owned : null
}

type TestStoredTurnOptions = {
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto' | null
  model: string | null
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
}

export function memoryTurnOptionsStore(initial: Record<string, TestStoredTurnOptions> = {}) {
  const sessionData = new Map(Object.entries(initial))
  const observedAtMs: number[] = []
  const store = {
    observedAtMs,
    acceptWrites: true,
    getSessionTurnOptions: (sessionId: string) => sessionData.get(sessionId) ?? null,
    setSessionTurnOptions: (sessionId: string, update: Partial<TestStoredTurnOptions>, observedAt = Date.now()) => {
      observedAtMs.push(observedAt)
      if (!store.acceptWrites) return false
      const current = sessionData.get(sessionId) ?? { permissionMode: null, model: null, effort: null }
      sessionData.set(sessionId, { ...current, ...update })
      return true
    },
    timelineVersion: (_projectId: string, sessionId: string) => `turn-options=${sessionData.has(sessionId) ? 1 : 0}`,
  }
  return store as typeof store & import('../turn-options-store.js').TurnOptionsStore
}

export function memorySettingsStore(initial: Record<string, unknown> = {}) {
  const data = { ...initial }
  const authSessions = new Map<string, import('../settings-store.js').AuthSession>()
  return {
    getAll: () => data,
    setMany(_scope: string, settings: Record<string, unknown>, options: { clearAuthSessions?: boolean } = {}) {
      for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) delete data[key]
        else data[key] = value
      }
      if (options.clearAuthSessions) authSessions.clear()
    },
    getAuthSession: (sessionId: string) => authSessions.get(sessionId) ?? null,
    setAuthSession(sessionId: string, session: import('../settings-store.js').AuthSession) {
      authSessions.set(sessionId, session)
    },
    deleteAuthSession(sessionId: string) {
      authSessions.delete(sessionId)
    },
  }
}

export function memoryRawTranscriptCache(sessionMessages: TimestampedSessionMessage[]) {
  const lines = buildRawLines(sessionMessages)
  return {
    ensureSessionCached: async () => ({ changed: false }) as const,
    loadTimelineWindow: (_sessionId: string, options: { limitTurns: number; cursor: string | null; fromTurnId: string | null; anchorTurnId?: string | null; excludeLocalCommandTurns?: boolean }) => {
      const roots = lines.filter((line) => line.uuid && line.owner_turn_id === line.uuid)
      const allTurns = roots.filter((line) => !options.excludeLocalCommandTurns || !timelineLocalCommand(JSON.parse(line.raw_json))).map((line) => line.uuid as string)
      const end = options.cursor ? allTurns.indexOf(options.cursor) : allTurns.length
      const anchorIndex = options.anchorTurnId ? allTurns.indexOf(options.anchorTurnId) : -1
      if ((options.cursor && end < 0) || (options.fromTurnId && !allTurns.includes(options.fromTurnId)) || (options.anchorTurnId && anchorIndex < 0))
        throw new TimelineAnchorStaleError(options.cursor ? 'cursor' : options.fromTurnId ? 'invalidation' : 'anchor')
      const selected = options.fromTurnId
        ? allTurns.slice(allTurns.indexOf(options.fromTurnId))
        : options.anchorTurnId
          ? allTurns.slice(Math.max(0, anchorIndex - options.limitTurns + 1), anchorIndex + 1)
          : allTurns.slice(Math.max(0, end - options.limitTurns), end)
      const selectedIds = new Set(selected)
      const ownedMessages = lines.flatMap((line) => {
        if (!line.owner_turn_id || !selectedIds.has(line.owner_turn_id)) return []
        return [{ ownerTurnId: line.owner_turn_id, message: JSON.parse(line.raw_json) as TimestampedSessionMessage }]
      })
      return {
        primaryTurns: selected.map((uuid) => {
          const timestamp = sessionMessages.find((message) => message.uuid === uuid)?.timestamp
          return { uuid, timestamp: timestamp ? Date.parse(timestamp) : null }
        }),
        ownedMessages,
        hasMore: !options.fromTurnId && (options.anchorTurnId ? anchorIndex - selected.length + 1 > 0 : end - selected.length > 0),
        hasNewer: Boolean(options.anchorTurnId) && anchorIndex >= 0 && anchorIndex < allTurns.length - 1,
        nextCursor: !options.fromTurnId && (options.anchorTurnId ? anchorIndex - selected.length + 1 > 0 : end - selected.length > 0) ? (selected[0] ?? null) : null,
        snapshotFromTurnId: options.fromTurnId,
        anchorTurnId: options.anchorTurnId ?? null,
        version: timelineState.version,
        fileSize: timelineState.fileSize!,
      }
    },
    adjacentTurnIds: (_sessionId: string, turnId: string, options: { excludeLocalCommandTurns?: boolean } = {}) => {
      const turns = lines
        .filter((line) => line.uuid && line.owner_turn_id === line.uuid && (!options.excludeLocalCommandTurns || !timelineLocalCommand(JSON.parse(line.raw_json))))
        .map((line) => line.uuid as string)
      const index = turns.indexOf(turnId)
      return index < 0 ? null : { firstTurnId: turns[0]!, previousTurnId: turns[index - 1] ?? null, nextTurnId: turns[index + 1] ?? null, latestTurnId: turns.at(-1)! }
    },
    loadRawLinesForTurn: (_sessionId: string, turnId: string) => rawLinesForTurn(lines, turnId),
    loadRawLinesByUuid: (sessionId: string, messageUuid: string) => lines.filter((line) => line.session_id === sessionId && line.uuid === messageUuid),
  }
}

export function memoryTranscriptIndex(
  sessionId = 'session-newest',
  projectId = project.id,
  summary = sessions.find(({ id }) => id === sessionId),
): Pick<TranscriptIndexStore, 'getSession' | 'getProject' | 'listProjectsPage' | 'listProjectSessionsPage'> {
  const projectPath = project.path!
  const indexedSession = {
    sessionId,
    currentProjectId: projectId,
    currentCwd: projectPath,
    transcriptPath: `/tmp/${sessionId}.jsonl`,
    fileSize: timelineState.fileSize ?? null,
    fileMtimeMs: summary?.lastActivityAt ?? null,
    lastVisibleMessageAtMs: summary?.lastActivityAt ?? null,
    customTitle: summary?.title ?? 'Custom newest',
    aiTitle: null,
    lastPrompt: null,
    summaryHint: 'Newest session',
    firstPrompt: 'First prompt',
    firstPromptLocked: true,
    commandFallback: null,
    gitBranch: 'main',
    isSidechain: false,
    entrypoint: null,
    sessionKind: summary?.kind ?? null,
    taskSnapshot: [],
    taskSnapshotVersion: 'missing',
    taskSnapshotUpdatedAtMs: null,
    isValidSessionId: true,
  }
  return {
    getSession: (requestedSessionId) => (requestedSessionId === sessionId ? indexedSession : null),
    getProject: (requestedProjectId) => (requestedProjectId === projectId ? { projectId, projectPath: projectPath, lastActivityAtMs: summary?.lastActivityAt ?? null } : null),
    listProjectsPage: () => ({ items: [{ projectId, projectPath: projectPath, lastActivityAtMs: summary?.lastActivityAt ?? null }], hasMore: false, nextKey: null }),
    listProjectSessionsPage: (requestedProjectId) => ({
      items: requestedProjectId === projectId ? [indexedSession] : [],
      hasMore: false,
      nextKey: null,
      defaultSessionId: requestedProjectId === projectId ? sessionId : null,
    }),
  }
}

export function createTestApp(liveStates: Record<string, SessionRunState> = {}, sessionMessages: TimestampedSessionMessage[] = messages, overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    timelineVersionReader: () => timelineState.version,

    liveTurnManager: {
      ensureRuntime: () => {},
      sessionRunState: (sessionId: string) => liveStates[sessionId] ?? null,
      runtimeTurnProjection: () => null,
      clearRuntimeTurnProjection: () => {},
      startTurn: async () => {
        throw new Error('not implemented')
      },
      acknowledgeCompletedTurn: () => false,
      interrupt: async () => false,
      subscribe: () => () => {},
    },
    rawTranscriptCache: memoryRawTranscriptCache(sessionMessages),
    transcriptIndex: memoryTranscriptIndex(),
    transcriptSyncer: async () => {},
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
          nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        }
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
      async getSessionTimelineState(projectId, sessionId) {
        if (projectId !== project.id || sessionId !== 'session-newest') return null
        return timelineState
      },
    },
    ...overrides,
  })
}
