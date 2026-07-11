import {
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ProjectSummary, SessionSummary } from '@cotta/shared'

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

function toProjectSummary(path: string, sessions: SDKSessionInfo[]): ProjectSummary {
  return {
    id: projectIdFromPath(path),
    name: projectNameFromPath(path),
    path,
    lastActivityAt: Math.max(...sessions.map((session) => session.lastModified)),
    sessionCount: sessions.length,
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

function toSessionSummary(projectId: string, session: SDKSessionInfo): SessionSummary {
  return {
    id: session.sessionId,
    title: titleFromSession(session),
    projectId,
    lastActivityAt: session.lastModified,
  }
}

export type ProjectSessions = {
  project: ProjectSummary
  sessions: SessionSummary[]
  defaultSessionId: string | null
}

export type ClaudeCodeApi = {
  listProjects(): Promise<ProjectSummary[]>
  getProject(projectId: string): Promise<ProjectSummary | null>
  listProjectSessions(projectId: string): Promise<ProjectSessions | null>
  getSessionMessages(projectId: string, sessionId: string): Promise<SessionMessage[] | null>
}

export function createClaudeCodeApi(): ClaudeCodeApi {
  return {
    async listProjects() {
      const sessions = await listSessions()
      return toProjectSummaries(sessions)
    },

    async getProject(projectId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = await listSessions({ dir: projectPath })
      if (sessions.length === 0) return null
      return toProjectSummary(projectPath, sessions)
    },

    async listProjectSessions(projectId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      const sessions = await listSessions({ dir: projectPath })
      if (sessions.length === 0) return null
      const project = toProjectSummary(projectPath, sessions)
      const sessionSummaries = sessions.map((session) => toSessionSummary(project.id, session))
      return {
        project,
        sessions: sessionSummaries,
        defaultSessionId: sessionSummaries[0]?.id ?? null,
      }
    },

    async getSessionMessages(projectId, sessionId) {
      const projectPath = projectPathFromId(projectId)
      if (!projectPath) return null
      return getSessionMessages(sessionId, {
        dir: projectPath,
        limit: 10_000,
        offset: 0,
        includeSystemMessages: true,
      })
    },
  }
}
