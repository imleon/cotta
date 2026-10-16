import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteSessionMock, forkSessionMock, getSessionInfoMock, listSessionsMock, renameSessionMock } = vi.hoisted(() => ({
  deleteSessionMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').deleteSession>(),
  forkSessionMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').forkSession>(),
  getSessionInfoMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').getSessionInfo>(),
  listSessionsMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').listSessions>(),
  renameSessionMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').renameSession>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: deleteSessionMock,
  forkSession: forkSessionMock,
  getSessionInfo: getSessionInfoMock,
  listSessions: listSessionsMock,
  renameSession: renameSessionMock,
}))

import { createClaudeCodeApi, projectIdFromPath, projectPathFromId } from './claude-code-api.js'

function projectId(path: string): string {
  return projectIdFromPath(path)
}

function session(overrides: Partial<SDKSessionInfo> & Pick<SDKSessionInfo, 'sessionId' | 'cwd'> & { lastVisibleMessageAtMs?: number | null }): SDKSessionInfo {
  return {
    customTitle: undefined,
    summary: '',
    firstPrompt: undefined,
    lastModified: 0,
    fileSize: 0,
    ...overrides,
  }
}

function indexFromSessions(sessions: Array<SDKSessionInfo & { lastVisibleMessageAtMs?: number | null }>) {
  const projects = new Map<string, { projectId: string; projectPath: string; lastActivityAtMs: number }>()
  for (const item of sessions) {
    if (!item.cwd) continue
    const path = item.cwd.replace(/\/+$/, '') || '/'
    const current = projects.get(path)
    const lastActivityAtMs = Math.max(current?.lastActivityAtMs ?? 0, item.lastModified)
    projects.set(path, { projectId: projectId(path), projectPath: path, lastActivityAtMs })
  }
  const listProjects = () => [...projects.values()].sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs || a.projectId.localeCompare(b.projectId))
  const activity = (item: { lastVisibleMessageAtMs?: number | null; lastModified?: number; fileMtimeMs?: number | null }) => item.lastVisibleMessageAtMs ?? item.lastModified ?? item.fileMtimeMs ?? 0
  const listProjectSessions = (id: string) =>
    sessions
      .filter((item) => item.cwd && projectId(item.cwd.replace(/\/+$/, '') || '/') === id)
      .sort((a, b) => activity(b) - activity(a) || a.sessionId.localeCompare(b.sessionId))
      .map((item) => ({
        sessionId: item.sessionId,
        currentProjectId: id,
        currentCwd: item.cwd?.replace(/\/+$/, '') || '/',
        transcriptPath: null,
        fileSize: item.fileSize ?? null,
        fileMtimeMs: item.lastModified,
        lastVisibleMessageAtMs: item.lastVisibleMessageAtMs ?? null,
        customTitle: item.customTitle ?? null,
        lastPrompt: item.summary || null,
      }))
  return {
    listProjects,
    listProjectsPage: ({ limit, after }: { limit: number; after?: { sort: number | null; id: string } | null }) => {
      const rows = listProjects().filter((project) => !after || project.lastActivityAtMs < (after.sort ?? -Infinity) || (project.lastActivityAtMs === after.sort && project.projectId > after.id))
      const items = rows.slice(0, limit)
      return { items, hasMore: rows.length > limit, nextKey: rows.length > limit ? { sort: items.at(-1)!.lastActivityAtMs, id: items.at(-1)!.projectId } : null }
    },
    getProject: (id: string) => [...projects.values()].find((project) => project.projectId === id) ?? null,
    listProjectSessions,
    getSession: (sessionId: string) =>
      listProjectSessions(projectId(sessions.find((item) => item.sessionId === sessionId)?.cwd?.replace(/\/+$/, '') || '')).find((item) => item.sessionId === sessionId) ?? null,
    listProjectSessionsPage: (id: string, { limit, after }: { limit: number; after?: { sort: number | null; id: string } | null }) => {
      const all = listProjectSessions(id)
      const rows = all.filter((session) => !after || activity(session) < (after.sort ?? -Infinity) || (activity(session) === after.sort && session.sessionId > after.id))
      const items = rows.slice(0, limit)
      return { items, defaultSessionId: all[0]?.sessionId ?? null, hasMore: rows.length > limit, nextKey: rows.length > limit ? { sort: activity(items.at(-1)!), id: items.at(-1)!.sessionId } : null }
    },
  }
}

describe('createClaudeCodeApi', () => {
  beforeEach(() => {
    deleteSessionMock.mockReset()
    forkSessionMock.mockReset()
    getSessionInfoMock.mockReset()
    listSessionsMock.mockReset()
    renameSessionMock.mockReset()
  })

  it('normalizes project paths before encoding ids', () => {
    expect(projectIdFromPath('/repo/cotta')).toBe(projectIdFromPath('/repo/cotta/'))
    expect(projectPathFromId(projectIdFromPath('/repo/cotta/'))).toBe('/repo/cotta')
    expect(projectPathFromId(projectIdFromPath('/'))).toBe('/')
  })

  it('does not mix sessions from /repo/cotta and /repo/cotta-v2 when loading a project', async () => {
    const api = createClaudeCodeApi({
      transcriptIndex: indexFromSessions([
        session({ sessionId: 'cotta-only', cwd: '/repo/cotta', lastModified: 2 }),
        session({ sessionId: 'cotta-v2-only', cwd: '/repo/cotta-v2', lastModified: 3 }),
      ]) as never,
    })
    const project = await api.getProject(projectId('/repo/cotta'))

    expect(project).toEqual({
      id: projectId('/repo/cotta'),
      name: 'cotta',
      path: '/repo/cotta',
      lastActivityAt: 2,
    })
    expect(listSessionsMock).not.toHaveBeenCalled()
  })

  it('lists worktrees as independent projects with the base project name', async () => {
    const worktreePath = '/repo/base/.claude/worktrees/feature-a'
    const api = createClaudeCodeApi({
      transcriptIndex: indexFromSessions([session({ sessionId: 'base', cwd: '/repo/base', lastModified: 2 }), session({ sessionId: 'worktree', cwd: worktreePath, lastModified: 3 })]) as never,
    })

    await expect(api.listProjects()).resolves.toMatchObject({
      projects: expect.arrayContaining([
        { id: projectId('/repo/base'), name: 'base', path: '/repo/base', lastActivityAt: 2 },
        { id: projectId(worktreePath), name: 'base', path: worktreePath, lastActivityAt: 3, worktreeName: 'feature-a' },
      ]),
    })
  })

  it('lists only exact-path sessions for a project', async () => {
    const api = createClaudeCodeApi({
      transcriptIndex: indexFromSessions([
        session({ sessionId: 'cotta-older', cwd: '/repo/cotta', lastModified: 1 }),
        session({ sessionId: 'cotta-v2-newer', cwd: '/repo/cotta-v2', lastModified: 10 }),
        session({ sessionId: 'cotta-newer', cwd: '/repo/cotta', lastModified: 5, customTitle: 'cotta-newer', summary: 'Latest prompt' }),
      ]) as never,
    })
    const result = await api.listProjectSessions(projectId('/repo/cotta'))

    expect(result).toEqual({
      project: {
        id: projectId('/repo/cotta'),
        name: 'cotta',
        path: '/repo/cotta',
        lastActivityAt: 5,
      },
      sessions: [
        {
          id: 'cotta-newer',
          title: 'cotta-newer',
          projectId: projectId('/repo/cotta'),
          lastActivityAt: 5,
          occupiedBy: null,
          occupiedStatus: 'idle',
          hasRunningShell: false,
          kind: null,
          currentCwd: '/repo/cotta',
          lastPrompt: 'Latest prompt',
        },
        {
          id: 'cotta-older',
          title: 'cotta-older',
          projectId: projectId('/repo/cotta'),
          lastActivityAt: 1,
          occupiedBy: null,
          occupiedStatus: 'idle',
          hasRunningShell: false,
          kind: null,
          currentCwd: '/repo/cotta',
        },
      ],
      defaultSessionId: 'cotta-newer',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('uses visible message activity for session summaries and falls back to mtime', async () => {
    const api = createClaudeCodeApi({
      transcriptIndex: indexFromSessions([
        session({ sessionId: 'newer-mtime', cwd: '/repo/cotta', lastModified: 10, lastVisibleMessageAtMs: 1 }),
        session({ sessionId: 'fallback-mtime', cwd: '/repo/cotta', lastModified: 5, lastVisibleMessageAtMs: null }),
        session({ sessionId: 'newer-visible', cwd: '/repo/cotta', lastModified: 2, lastVisibleMessageAtMs: 9 }),
      ]) as never,
    })

    await expect(api.listProjectSessions(projectId('/repo/cotta'))).resolves.toMatchObject({
      sessions: [
        { id: 'newer-visible', lastActivityAt: 9 },
        { id: 'fallback-mtime', lastActivityAt: 5 },
        { id: 'newer-mtime', lastActivityAt: 1 },
      ],
      defaultSessionId: 'newer-visible',
    })
  })

  it('continues keyset pagination after newer rows appear before the cursor', async () => {
    const first = [
      session({ sessionId: 's1', cwd: '/repo/cotta', lastModified: 3 }),
      session({ sessionId: 's2', cwd: '/repo/cotta', lastModified: 2 }),
      session({ sessionId: 's3', cwd: '/repo/cotta', lastModified: 1 }),
    ]
    const second = [session({ sessionId: 's0', cwd: '/repo/cotta', lastModified: 4 }), ...first]
    const transcriptIndex = indexFromSessions(first)
    const api = createClaudeCodeApi({ transcriptIndex: transcriptIndex as never })
    const firstPage = await api.listProjectSessions(projectId('/repo/cotta'), { limit: 2 })
    Object.assign(transcriptIndex, indexFromSessions(second))

    await expect(api.listProjectSessions(projectId('/repo/cotta'), { limit: 2, cursor: firstPage?.nextCursor })).resolves.toMatchObject({
      sessions: [{ id: 's3' }],
      defaultSessionId: 's0',
      hasMore: false,
    })
  })

  it('uses one optional timeline version provider for timeline state', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'old', cwd: '/repo/cotta', lastModified: 200, fileSize: 10 }))
    const timelineVersionProvider = vi.fn(async (_projectId: string, _sessionId: string, baseVersion: string) => `${baseVersion};metadata=3`)
    const api = createClaudeCodeApi({ timelineVersionProvider })

    const state = await api.getSessionTimelineState(projectId('/repo/cotta'), 'old')

    expect(state?.version).toBe('timeline-state-v1:mtime=200;size=10;metadata=3')
    expect(timelineVersionProvider).toHaveBeenCalledTimes(1)
    expect(timelineVersionProvider).toHaveBeenCalledWith(projectId('/repo/cotta'), 'old', 'timeline-state-v1:mtime=200;size=10')
  })

  it('falls back to the base timeline version when the provider fails', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'old', cwd: '/repo/cotta', lastModified: 200, fileSize: 10 }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = createClaudeCodeApi({
      timelineVersionProvider: async () => {
        throw new Error('sidecar failed')
      },
    })

    const state = await api.getSessionTimelineState(projectId('/repo/cotta'), 'old')

    expect(state?.version).toBe('timeline-state-v1:mtime=200;size=10')
    errorSpy.mockRestore()
  })

  it('returns null timeline state for a session that belongs to a sibling worktree path', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'other', cwd: '/repo/cotta-v2', lastModified: 10, fileSize: 99 }))

    const api = createClaudeCodeApi()

    await expect(api.getSessionTimelineState(projectId('/repo/cotta'), 'other')).resolves.toBeNull()
    expect(getSessionInfoMock).toHaveBeenCalledWith('other', { dir: '/repo/cotta' })
    expect(listSessionsMock).not.toHaveBeenCalled()
  })

  it('deletes an exact project session through the SDK', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta', lastModified: 10 }))

    const api = createClaudeCodeApi()

    await expect(api.deleteSession(projectId('/repo/cotta'), 'session-1')).resolves.toBe(true)
    expect(deleteSessionMock).toHaveBeenCalledWith('session-1', { dir: '/repo/cotta' })
  })

  it('renames an exact project session through the SDK', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta', lastModified: 10 }))

    const api = createClaudeCodeApi()

    await expect(api.renameSession(projectId('/repo/cotta'), 'session-1', 'New title')).resolves.toBe(true)
    expect(renameSessionMock).toHaveBeenCalledWith('session-1', 'New title', { dir: '/repo/cotta' })
  })

  it('forks an exact project session through the SDK without a title', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta', lastModified: 10 }))
    forkSessionMock.mockResolvedValue({ sessionId: 'fork-1' })
    const api = createClaudeCodeApi()

    await expect(api.forkSession(projectId('/repo/cotta'), 'session-1', '123e4567-e89b-12d3-a456-426614174000')).resolves.toBe('fork-1')
    expect(forkSessionMock).toHaveBeenCalledWith('session-1', { dir: '/repo/cotta', upToMessageId: '123e4567-e89b-12d3-a456-426614174000' })
    expect(forkSessionMock.mock.calls[0]?.[1]).not.toHaveProperty('title')
  })

  it('forks an entire exact project session without a message target', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta', lastModified: 10 }))
    forkSessionMock.mockResolvedValue({ sessionId: 'fork-1' })
    const api = createClaudeCodeApi()

    await expect(api.forkSession(projectId('/repo/cotta'), 'session-1')).resolves.toBe('fork-1')
    expect(forkSessionMock).toHaveBeenCalledWith('session-1', { dir: '/repo/cotta' })
  })

  it('does not fork a session from a sibling worktree path', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta-v2', lastModified: 10 }))
    const api = createClaudeCodeApi()

    await expect(api.forkSession(projectId('/repo/cotta'), 'session-1', '123e4567-e89b-12d3-a456-426614174000')).resolves.toBeNull()
    expect(forkSessionMock).not.toHaveBeenCalled()
  })

  it('does not delete a session from a sibling worktree path', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta-v2', lastModified: 10 }))

    const api = createClaudeCodeApi()

    await expect(api.deleteSession(projectId('/repo/cotta'), 'session-1')).resolves.toBe(false)
    expect(deleteSessionMock).not.toHaveBeenCalled()
  })

  it('does not rename a session from a sibling worktree path', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'session-1', cwd: '/repo/cotta-v2', lastModified: 10 }))

    const api = createClaudeCodeApi()

    await expect(api.renameSession(projectId('/repo/cotta'), 'session-1', 'New title')).resolves.toBe(false)
    expect(renameSessionMock).not.toHaveBeenCalled()
  })

  it('treats trailing slashes as the same project path', async () => {
    const api = createClaudeCodeApi({
      transcriptIndex: indexFromSessions([session({ sessionId: 'slashy', cwd: '/repo/cotta/', lastModified: 7 }), session({ sessionId: 'other', cwd: '/repo/cotta-v2/', lastModified: 8 })]) as never,
    })

    await expect(api.getProject(projectId('/repo/cotta'))).resolves.toEqual({
      id: projectId('/repo/cotta'),
      name: 'cotta',
      path: '/repo/cotta',
      lastActivityAt: 7,
    })
  })
})
