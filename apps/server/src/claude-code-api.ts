import { listSessions, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectSummary } from '@cotta/shared'

function projectIdFromPath(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

function projectNameFromPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).at(-1)
  return name || path
}

function toProjectSummaries(sessions: SDKSessionInfo[]): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>()

  for (const session of sessions) {
    if (!session.cwd) continue
    const existing = projects.get(session.cwd)
    const lastActivityAt = session.lastModified
    if (existing) {
      existing.sessionCount = (existing.sessionCount ?? 0) + 1
      existing.lastActivityAt = Math.max(existing.lastActivityAt ?? 0, lastActivityAt)
      continue
    }

    projects.set(session.cwd, {
      id: projectIdFromPath(session.cwd),
      name: projectNameFromPath(session.cwd),
      path: session.cwd,
      lastActivityAt,
      sessionCount: 1,
    })
  }

  return [...projects.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
}

export type ClaudeCodeApi = {
  listProjects(): Promise<ProjectSummary[]>
}

export function createClaudeCodeApi(): ClaudeCodeApi {
  return {
    async listProjects() {
      const sessions = await listSessions()
      return toProjectSummaries(sessions)
    },
  }
}
