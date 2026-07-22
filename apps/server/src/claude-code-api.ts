import {
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ProjectSummary, SessionSummary, SessionTimelineState } from '@cotta/shared'
import type { SessionSummaryCache } from './session-summary-cache.js'

function projectIdFromPath(path: string): string {
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

type SessionActivityCacheEntry = { fileSize?: number; lastActivityAt: number }

const sessionActivityCache = new Map<string, SessionActivityCacheEntry>()

function visibleLastActivityAt(projectPath: string, session: SDKSessionInfo): number {
  const key = `${projectPath}:${session.sessionId}`
  const cached = sessionActivityCache.get(key)
  if (cached && cached.fileSize !== undefined && session.fileSize !== undefined && cached.fileSize === session.fileSize) {
    return cached.lastActivityAt
  }

  const lastActivityAt = session.lastModified
  sessionActivityCache.set(key, { fileSize: session.fileSize, lastActivityAt })
  return lastActivityAt
}

function sortSessions(projectPath: string, sessions: SDKSessionInfo[]): SDKSessionInfo[] {
  return [...sessions].sort((a, b) => {
    const byTime = visibleLastActivityAt(projectPath, b) - visibleLastActivityAt(projectPath, a)
    return byTime !== 0 ? byTime : a.sessionId.localeCompare(b.sessionId)
  })
}

function toProjectSummary(path: string, sessions: SDKSessionInfo[]): ProjectSummary {
  return {
    id: projectIdFromPath(path),
    name: projectNameFromPath(path),
    path,
    lastActivityAt: Math.max(...sessions.map((session) => visibleLastActivityAt(path, session))),
  }
}

function toProjectSummaries(sessions: SDKSessionInfo[]): ProjectSummary[] {
  const sessionsByPath = new Map<string, SDKSessionInfo[]>()
  for (const session of sessions) {
    if (!session.cwd) continue
    const projectSessions = sessionsByPath.get(session.cwd) ?? []
    projectSessions.push(session)
    sessionsByPath.set(session.cwd, projectSessions)
  }
  return [...sessionsByPath.entries()]
    .map(([path, projectSessions]) => toProjectSummary(path, projectSessions))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
}

function toSessionSummary(projectPath: string, projectId: string, session: SDKSessionInfo): SessionSummary {
  return {
    id: session.sessionId,
    title: titleFromSession(session),
    projectId,
    lastActivityAt: visibleLastActivityAt(projectPath, session),
  }
}

export function sessionTimelineSignature(session: SDKSessionInfo): string {
  return [`mtime=${session.lastModified}`, `size=${session.fileSize ?? 'unknown'}`].join(';')
}

export function sessionTimelineVersion(session: SDKSessionInfo): string {
  return `timeline-state-v1:${sessionTimelineSignature(session)}`
}

function toSessionTimelineState(projectPath: string, projectId: string, session: SDKSessionInfo): SessionTimelineState {
  return {
    projectId,
    sessionId: session.sessionId,
    version: sessionTimelineVersion(session),
    signature: sessionTimelineSignature(session),
    lastActivityAt: visibleLastActivityAt(projectPath, session),
    fileSize: session.fileSize,
    generatedAt: Date.now(),
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
  getSessionTimelineState(projectId: string, sessionId: string): Promise<SessionTimelineState | null>
  getSessionMessages(projectId: string, sessionId: string): Promise<SessionMessage[] | null>
}

export function createClaudeCodeApi(cache?: SessionSummaryCache): ClaudeCodeApi {
  return {
    async listProjects(options = {}) {
      if (cache) return cache.listProjects(options)
      const sessions = await listSessions({ includeWorktrees: true, includeProgrammatic: true })
      const projects = toProjectSummaries(sessions)
      const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 20)))
      const cursorIndex = options.cursor ? projects.findIndex((project) => project.id === options.cursor) : -1
      const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
      const page = projects.slice(start, start + limit)
      const hasMore = start + limit < projects.length
      return {
        projects: page,
        hasMore,
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      }
    },

    async getProject(projectId) {
      if (cache) return cache.getProject(projectId)
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = await listExactProjectSessions(projectPath)
      if (sessions.length === 0) return null
      const project = toProjectSummary(projectPath, sessions)
      return project
    },

    async listProjectSessions(projectId, options = {}) {
      if (cache) return cache.listProjectSessions(projectId, options)
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = sortSessions(projectPath, await listExactProjectSessions(projectPath))
      if (sessions.length === 0) return null
      const project = toProjectSummary(projectPath, sessions)
      const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 10)))
      const cursorIndex = options.cursor ? sessions.findIndex((session) => session.sessionId === options.cursor) : -1
      const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
      const page = sessions.slice(start, start + limit)
      const hasMore = start + limit < sessions.length
      return {
        project,
        sessions: page.map((session) => toSessionSummary(projectPath, project.id, session)),
        defaultSessionId: sessions[0]?.sessionId ?? null,
        hasMore,
        nextCursor: hasMore ? page.at(-1)?.sessionId ?? null : null,
      }
    },

    async getSessionTimelineState(projectId, sessionId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = await listExactProjectSessions(projectPath)
      const session = sessions.find((candidate) => candidate.sessionId === sessionId)
      if (!session) return null
      return toSessionTimelineState(projectPath, projectId, session)
    },

    async getSessionMessages(projectId, sessionId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = await listExactProjectSessions(projectPath)
      if (!sessions.some((session) => session.sessionId === sessionId)) return null
      return getSessionMessages(sessionId, {
        dir: projectPath,
        limit: 10_000,
        offset: 0,
        includeSystemMessages: true,
      })
    },
  }
}
