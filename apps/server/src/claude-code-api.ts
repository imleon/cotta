import type { ProjectSummary, SessionSummary } from '@cotta/shared'
import { createKeysetListCursor, resolveKeysetListCursor } from './list-cursor.js'
import { normalizeProjectPath, projectIdFromPath, projectPathFromId } from './project-path.js'
import { deleteSessionTranscript, forkSessionTranscript, renameSessionTranscript, type SessionMutationOperation, type SessionMutationTarget } from './session-transcript-mutations.js'
import type { IndexedProject, IndexedSession, TranscriptIndexStore } from './transcript-index-store.js'

export { projectIdFromPath, projectPathFromId }

function projectNameFromPath(path: string): string {
  const normalized = normalizeProjectPath(path)
  const name = normalized.split('/').filter(Boolean).at(-1)
  return name || path
}

type SessionTitleInput = {
  sessionId: string
  customTitle?: string | null
  aiTitle?: string | null
  lastPrompt?: string | null
  summary?: string | null
  summaryHint?: string | null
  firstPrompt?: string | null
  firstPromptLocked?: boolean | null
  commandFallback?: string | null
}

export function sessionTitle(input: SessionTitleInput): string {
  return input.customTitle || input.aiTitle || input.lastPrompt || input.summaryHint || input.summary || (input.firstPromptLocked ? input.firstPrompt : input.commandFallback) || input.sessionId
}

const WORKTREE_SEGMENT = '/.claude/worktrees/'

function sessionActivityAt(session: Pick<IndexedSession, 'lastVisibleMessageAtMs' | 'fileMtimeMs'>): number {
  return session.lastVisibleMessageAtMs ?? session.fileMtimeMs ?? 0
}

export function projectDisplayMetadataFromPath(path: string): Pick<ProjectSummary, 'name' | 'worktreeName'> {
  const normalized = normalizeProjectPath(path)
  const index = normalized.indexOf(WORKTREE_SEGMENT)
  if (index < 0) return { name: projectNameFromPath(normalized) }
  const basePath = normalizeProjectPath(normalized.slice(0, index))
  const worktreeName = normalized.slice(index + WORKTREE_SEGMENT.length)
  if (!basePath || basePath === normalized || !worktreeName) return { name: projectNameFromPath(normalized) }
  return { name: projectNameFromPath(basePath), worktreeName }
}

function toProjectSummary(project: IndexedProject): ProjectSummary {
  return {
    id: project.projectId,
    ...projectDisplayMetadataFromPath(project.projectPath),
    path: project.projectPath,
    lastActivityAt: project.lastActivityAtMs ?? 0,
  }
}

export function toSessionSummary(session: IndexedSession): SessionSummary {
  return {
    id: session.sessionId,
    title: sessionTitle(session),
    projectId: session.currentProjectId ?? '',
    lastActivityAt: sessionActivityAt(session),
    occupiedBy: null,
    occupiedStatus: 'idle',
    hasRunningShell: false,
    kind: session.sessionKind ?? null,
    currentCwd: session.currentCwd,
    ...(session.lastPrompt ? { lastPrompt: session.lastPrompt } : {}),
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

export type ClaudeCodeApiOptions = {
  transcriptIndex?: Pick<TranscriptIndexStore, 'getProject' | 'listProjectsPage' | 'listProjectSessionsPage'>
  beforeList?: () => Promise<void>
  mutationTarget?: (projectId: string, sessionId: string, operation: SessionMutationOperation) => Promise<SessionMutationTarget | null>
}

export type ClaudeCodeApi = {
  listProjects(options?: ProjectSessionsOptions): Promise<{ projects: ProjectSummary[]; hasMore: boolean; nextCursor: string | null }>
  getProject(projectId: string): Promise<ProjectSummary | null>
  listProjectSessions(projectId: string, options?: ProjectSessionsOptions): Promise<ProjectSessions | null>
  renameSession(projectId: string, sessionId: string, title: string): Promise<boolean>
  forkSession(projectId: string, sessionId: string, upToMessageId?: string): Promise<string | null>
  deleteSession(projectId: string, sessionId: string): Promise<boolean>
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function createClaudeCodeApi(options: ClaudeCodeApiOptions = {}): ClaudeCodeApi {
  const mutationTarget = (projectId: string, sessionId: string, operation: SessionMutationOperation) => {
    if (!options.mutationTarget) throw new Error('Session transcript mutations are not configured')
    return options.mutationTarget(projectId, sessionId, operation)
  }

  return {
    async listProjects(listOptions = {}) {
      await options.beforeList?.()
      const limit = Math.max(1, Math.min(10_000, Math.trunc(listOptions.limit ?? 20)))
      const after = listOptions.cursor ? resolveKeysetListCursor({ cursor: listOptions.cursor, kind: 'projects' }) : null
      const page = options.transcriptIndex?.listProjectsPage({ limit, after }) ?? { items: [], hasMore: false, nextKey: null }
      return {
        projects: page.items.map(toProjectSummary),
        hasMore: page.hasMore,
        nextCursor: page.hasMore && page.nextKey ? createKeysetListCursor({ kind: 'projects', key: page.nextKey }) : null,
      }
    },

    async getProject(projectId) {
      await options.beforeList?.()
      const project = options.transcriptIndex?.getProject(projectId)
      return project ? toProjectSummary(project) : null
    },

    async listProjectSessions(projectId, listOptions = {}) {
      await options.beforeList?.()
      const project = options.transcriptIndex?.getProject(projectId)
      if (!project) return null
      const limit = Math.max(1, Math.min(10_000, Math.trunc(listOptions.limit ?? 10)))
      const after = listOptions.cursor ? resolveKeysetListCursor({ cursor: listOptions.cursor, kind: 'project-sessions', projectId }) : null
      const page = options.transcriptIndex?.listProjectSessionsPage(projectId, { limit, after }) ?? { items: [], hasMore: false, nextKey: null, defaultSessionId: null }
      return {
        project: toProjectSummary(project),
        sessions: page.items.map(toSessionSummary),
        defaultSessionId: page.defaultSessionId ?? null,
        hasMore: page.hasMore,
        nextCursor: page.hasMore && page.nextKey ? createKeysetListCursor({ kind: 'project-sessions', key: page.nextKey, projectId }) : null,
      }
    },

    async renameSession(projectId, sessionId, title) {
      const target = await mutationTarget(projectId, sessionId, 'rename')
      if (!target) return false
      try {
        await renameSessionTranscript(target, sessionId, title)
      } catch (error) {
        if (isEnoent(error)) return false
        throw error
      }
      return true
    },

    async forkSession(projectId, sessionId, upToMessageId) {
      const target = await mutationTarget(projectId, sessionId, 'fork')
      if (!target) return null
      try {
        return await forkSessionTranscript(target, sessionId, upToMessageId)
      } catch (error) {
        if (isEnoent(error)) return null
        throw error
      }
    },

    async deleteSession(projectId, sessionId) {
      const target = await mutationTarget(projectId, sessionId, 'delete')
      if (!target) return false
      try {
        await deleteSessionTranscript(target, sessionId)
      } catch (error) {
        if (isEnoent(error)) return false
        throw error
      }
      return true
    },
  }
}
