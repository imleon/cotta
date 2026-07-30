import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import type { ProjectSummary, SessionInfoResponse, SessionRunState, SessionSummary, SessionTimelineState } from '@cotta/shared'
import { createListCursor, resolveListCursor } from './list-cursor.js'
import { SessionActivityTracker } from './session-activity.js'
import type { SessionSummaryCache } from './session-summary-cache.js'

export function projectIdFromPath(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

export function projectPathFromId(id: string): string | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8')
    return decoded || null
  } catch (_error) {
    return null
  }
}

function projectNameFromPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).at(-1)
  return name || path
}

function titleFromSession(session: SDKSessionInfo): string {
  return session.customTitle || session.summary || session.firstPrompt || session.sessionId
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

function isExactProjectPath(projectPath: string, sessionPath: string | undefined): boolean {
  return !!sessionPath && normalizeProjectPath(sessionPath) === normalizeProjectPath(projectPath)
}

async function listExactProjectSessions(projectPath: string): Promise<SDKSessionInfo[]> {
  const sessions = await listSessions({ dir: projectPath, includeWorktrees: true, includeProgrammatic: true })
  return sessions.filter((session) => isExactProjectPath(projectPath, session.cwd))
}

async function getExactProjectSession(projectPath: string, sessionId: string): Promise<SDKSessionInfo | null> {
  const session = await getSessionInfo(sessionId, { dir: projectPath })
  return session && isExactProjectPath(projectPath, session.cwd) ? session : null
}

function sortSessions(activity: SessionActivityTracker, sessions: SDKSessionInfo[]): SDKSessionInfo[] {
  return [...sessions].sort((a, b) => {
    const byTime = activity.get(b) - activity.get(a)
    return byTime !== 0 ? byTime : a.sessionId.localeCompare(b.sessionId)
  })
}

function toProjectSummary(activity: SessionActivityTracker, path: string, sessions: SDKSessionInfo[]): ProjectSummary {
  return {
    id: projectIdFromPath(path),
    name: projectNameFromPath(path),
    path,
    lastActivityAt: Math.max(...sessions.map((session) => activity.get(session))),
  }
}

function toProjectSummaries(activity: SessionActivityTracker, sessions: SDKSessionInfo[]): ProjectSummary[] {
  const sessionsByPath = new Map<string, SDKSessionInfo[]>()
  for (const session of sessions) {
    if (!session.cwd) continue
    const projectSessions = sessionsByPath.get(session.cwd) ?? []
    projectSessions.push(session)
    sessionsByPath.set(session.cwd, projectSessions)
  }
  return [...sessionsByPath.entries()]
    .map(([path, projectSessions]) => toProjectSummary(activity, path, projectSessions))
    .sort((a, b) => {
      const byTime = (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
    })
}

function defaultRunState(): SessionRunState {
  return { phase: 'idle', activeTurnId: null }
}

function toSessionSummary(activity: SessionActivityTracker, projectId: string, session: SDKSessionInfo): SessionSummary {
  return {
    id: session.sessionId,
    title: titleFromSession(session),
    projectId,
    lastActivityAt: activity.get(session),
    runState: defaultRunState(),
  }
}

export function sessionTimelineSignature(session: SDKSessionInfo): string {
  return [`mtime=${session.lastModified}`, `size=${session.fileSize ?? 'unknown'}`].join(';')
}

export function sessionTimelineVersion(session: SDKSessionInfo): string {
  return `timeline-state-v1:${sessionTimelineSignature(session)}`
}

function toSessionTimelineState(_activity: SessionActivityTracker, projectId: string, session: SDKSessionInfo): SessionTimelineState {
  return {
    projectId,
    sessionId: session.sessionId,
    version: sessionTimelineVersion(session),
    signature: sessionTimelineSignature(session),
    fileSize: session.fileSize,
    generatedAt: Date.now(),
  }
}

function toSessionInfo(projectId: string, session: SDKSessionInfo): SessionInfoResponse {
  return {
    projectId,
    sessionId: session.sessionId,
    version: sessionTimelineVersion(session),
    signature: sessionTimelineSignature(session),
    generatedAt: Date.now(),
    summary: session.summary,
    lastModified: session.lastModified,
    fileSize: session.fileSize,
    customTitle: session.customTitle,
    firstPrompt: session.firstPrompt,
    gitBranch: session.gitBranch,
    cwd: session.cwd,
    tag: session.tag,
    createdAt: session.createdAt,
  }
}

export type ProjectSessionsOptions = {
  limit?: number
  cursor?: string | null
}

export type ProjectSessions = {
  project: ProjectSummary
  sessions: SessionSummary[]
  defaultSessionId: string | null
  hasMore: boolean
  nextCursor: string | null
}

export type ClaudeCodeApi = {
  listProjects(options?: ProjectSessionsOptions): Promise<{ projects: ProjectSummary[]; hasMore: boolean; nextCursor: string | null }>
  getProject(projectId: string): Promise<ProjectSummary | null>
  listProjectSessions(projectId: string, options?: ProjectSessionsOptions): Promise<ProjectSessions | null>
  getSessionInfo(projectId: string, sessionId: string): Promise<SessionInfoResponse | null>
  getSessionTimelineState(projectId: string, sessionId: string): Promise<SessionTimelineState | null>
  getSessionMessages(projectId: string, sessionId: string): Promise<SessionMessage[] | null>
}

export function createClaudeCodeApi(cache?: SessionSummaryCache): ClaudeCodeApi {
  const paginationEpoch = randomUUID()
  const activity = cache?.activity ?? new SessionActivityTracker()

  return {
    async listProjects(options = {}) {
      if (cache) return cache.listProjects(options)
      const sessions = await listSessions({ includeWorktrees: true, includeProgrammatic: true })
      const projects = toProjectSummaries(activity, sessions)
      const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 20)))
      const ids = projects.map((project) => project.id)
      const start = options.cursor
        ? resolveListCursor({ cursor: options.cursor, kind: 'projects', epoch: paginationEpoch, ids })
        : 0
      const page = projects.slice(start, start + limit)
      const hasMore = start + limit < projects.length
      const offset = start + page.length
      return {
        projects: page,
        hasMore,
        nextCursor: hasMore && page.length > 0
          ? createListCursor({ kind: 'projects', epoch: paginationEpoch, ids, offset })
          : null,
      }
    },

    async getProject(projectId) {
      if (cache) return cache.getProject(projectId)
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = await listExactProjectSessions(projectPath)
      if (sessions.length === 0) return null
      const project = toProjectSummary(activity, projectPath, sessions)
      return project
    },

    async listProjectSessions(projectId, options = {}) {
      if (cache) return cache.listProjectSessions(projectId, options)
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = sortSessions(activity, await listExactProjectSessions(projectPath))
      if (sessions.length === 0) return null
      const project = toProjectSummary(activity, projectPath, sessions)
      const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 10)))
      const ids = sessions.map((session) => session.sessionId)
      const start = options.cursor
        ? resolveListCursor({ cursor: options.cursor, kind: 'project-sessions', epoch: paginationEpoch, ids, projectId })
        : 0
      const page = sessions.slice(start, start + limit)
      const hasMore = start + limit < sessions.length
      const offset = start + page.length
      return {
        project,
        sessions: page.map((session) => toSessionSummary(activity, project.id, session)),
        defaultSessionId: sessions[0]?.sessionId ?? null,
        hasMore,
        nextCursor: hasMore && page.length > 0
          ? createListCursor({ kind: 'project-sessions', epoch: paginationEpoch, ids, offset, projectId })
          : null,
      }
    },

    async getSessionInfo(projectId, sessionId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const session = await getExactProjectSession(projectPath, sessionId)
      if (!session) return null
      return toSessionInfo(projectId, session)
    },

    async getSessionTimelineState(projectId, sessionId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const session = await getExactProjectSession(projectPath, sessionId)
      if (!session) return null
      return toSessionTimelineState(activity, projectId, session)
    },

    async getSessionMessages(projectId, sessionId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const session = await getExactProjectSession(projectPath, sessionId)
      if (!session) return null
      return getSessionMessages(sessionId, {
        dir: projectPath,
        limit: 10_000,
        offset: 0,
        includeSystemMessages: true,
      })
    },
  }
}
