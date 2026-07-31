import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'

const { deleteSessionMock, forkSessionMock, getSessionInfoMock, listSessionsMock, getSessionMessagesMock, renameSessionMock } = vi.hoisted(() => ({
  deleteSessionMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').deleteSession>(),
  forkSessionMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').forkSession>(),
  getSessionInfoMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').getSessionInfo>(),
  listSessionsMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').listSessions>(),
  getSessionMessagesMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').getSessionMessages>(),
  renameSessionMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').renameSession>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: deleteSessionMock,
  forkSession: forkSessionMock,
  getSessionInfo: getSessionInfoMock,
  listSessions: listSessionsMock,
  getSessionMessages: getSessionMessagesMock,
  renameSession: renameSessionMock,
}))

import { createClaudeCodeApi } from './claude-code-api.js'
import { SessionSummaryCache } from './session-summary-cache.js'

function projectId(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

const idleRunState = { phase: 'idle' as const, activeUserMessageUuid: null }

function session(overrides: Partial<SDKSessionInfo> & Pick<SDKSessionInfo, 'sessionId' | 'cwd'>): SDKSessionInfo {
  return {
    customTitle: undefined,
    summary: '',
    firstPrompt: undefined,
    lastModified: 0,
    fileSize: 0,
    ...overrides,
  }
}

describe('createClaudeCodeApi', () => {
  beforeEach(() => {
    deleteSessionMock.mockReset()
    forkSessionMock.mockReset()
    getSessionInfoMock.mockReset()
    listSessionsMock.mockReset()
    getSessionMessagesMock.mockReset()
    renameSessionMock.mockReset()
  })

  it('does not mix sessions from /repo/cotta and /repo/cotta-v2 when loading a project', async () => {
    listSessionsMock.mockResolvedValue([
      session({ sessionId: 'cotta-only', cwd: '/repo/cotta', lastModified: 2 }),
      session({ sessionId: 'cotta-v2-only', cwd: '/repo/cotta-v2', lastModified: 3 }),
    ])

    const api = createClaudeCodeApi()
    const project = await api.getProject(projectId('/repo/cotta'))

    expect(project).toEqual({
      id: projectId('/repo/cotta'),
      name: 'cotta',
      path: '/repo/cotta',
      lastActivityAt: 2,
    })
    expect(listSessionsMock).toHaveBeenCalledWith({ dir: '/repo/cotta', includeWorktrees: true, includeProgrammatic: true })
  })

  it('lists only exact-path sessions for a project', async () => {
    listSessionsMock.mockResolvedValue([
      session({ sessionId: 'cotta-older', cwd: '/repo/cotta', lastModified: 1 }),
      session({ sessionId: 'cotta-v2-newer', cwd: '/repo/cotta-v2', lastModified: 10 }),
      session({ sessionId: 'cotta-newer', cwd: '/repo/cotta', lastModified: 5 }),
    ])

    const api = createClaudeCodeApi()
    const result = await api.listProjectSessions(projectId('/repo/cotta'))

    expect(result).toEqual({
      project: {
        id: projectId('/repo/cotta'),
        name: 'cotta',
        path: '/repo/cotta',
        lastActivityAt: 5,
        },
      sessions: [
        { id: 'cotta-newer', title: 'cotta-newer', projectId: projectId('/repo/cotta'), lastActivityAt: 5, runState: idleRunState },
        { id: 'cotta-older', title: 'cotta-older', projectId: projectId('/repo/cotta'), lastActivityAt: 1, runState: idleRunState },
      ],
      defaultSessionId: 'cotta-newer',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('rejects a direct-adapter cursor after its sorted prefix changes', async () => {
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/cotta', lastModified: 3 }),
        session({ sessionId: 's2', cwd: '/repo/cotta', lastModified: 2 }),
        session({ sessionId: 's3', cwd: '/repo/cotta', lastModified: 1 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 's2', cwd: '/repo/cotta', lastModified: 4, fileSize: 1 }),
        session({ sessionId: 's1', cwd: '/repo/cotta', lastModified: 3 }),
        session({ sessionId: 's3', cwd: '/repo/cotta', lastModified: 1 }),
      ])

    const api = createClaudeCodeApi()
    const firstPage = await api.listProjectSessions(projectId('/repo/cotta'), { limit: 2 })

    await expect(api.listProjectSessions(projectId('/repo/cotta'), { limit: 2, cursor: firstPage?.nextCursor })).rejects.toMatchObject({ code: 'stale' })
  })

  it('shares visible activity with the summary cache without hiding timeline changes', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([
      session({ sessionId: 'old', cwd: '/repo/cotta', lastModified: 100, fileSize: 10 }),
    ])
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'old', cwd: '/repo/cotta', lastModified: 200, fileSize: 10 }))

    await cache.scheduleRefresh()
    const api = createClaudeCodeApi(cache)

    await expect(api.getSessionTimelineState(projectId('/repo/cotta'), 'old')).resolves.toMatchObject({
      signature: 'mtime=200;size=10',
      version: 'timeline-state-v1:mtime=200;size=10',
    })
  })

  it('returns null timeline state for a session that belongs to a sibling worktree path', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'other', cwd: '/repo/cotta-v2', lastModified: 10, fileSize: 99 }))

    const api = createClaudeCodeApi()

    await expect(api.getSessionTimelineState(projectId('/repo/cotta'), 'other')).resolves.toBeNull()
    expect(getSessionInfoMock).toHaveBeenCalledWith('other', { dir: '/repo/cotta' })
    expect(listSessionsMock).not.toHaveBeenCalled()
  })

  it('does not read messages for a session that belongs to a sibling worktree path', async () => {
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'other', cwd: '/repo/cotta-v2', lastModified: 10 }))

    const api = createClaudeCodeApi()

    await expect(api.getSessionMessages(projectId('/repo/cotta'), 'other')).resolves.toBeNull()
    expect(getSessionInfoMock).toHaveBeenCalledWith('other', { dir: '/repo/cotta' })
    expect(getSessionMessagesMock).not.toHaveBeenCalled()
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
    listSessionsMock.mockResolvedValue([
      session({ sessionId: 'slashy', cwd: '/repo/cotta/', lastModified: 7 }),
      session({ sessionId: 'other', cwd: '/repo/cotta-v2/', lastModified: 8 }),
    ])
    getSessionInfoMock.mockResolvedValue(session({ sessionId: 'slashy', cwd: '/repo/cotta/', lastModified: 7 }))
    getSessionMessagesMock.mockResolvedValue([])

    const api = createClaudeCodeApi()

    await expect(api.getProject(projectId('/repo/cotta'))).resolves.toEqual({
      id: projectId('/repo/cotta'),
      name: 'cotta',
      path: '/repo/cotta',
      lastActivityAt: 7,
    })
    await expect(api.getSessionMessages(projectId('/repo/cotta'), 'slashy')).resolves.toEqual([])
    expect(getSessionInfoMock).toHaveBeenCalledWith('slashy', { dir: '/repo/cotta' })
    expect(getSessionMessagesMock).toHaveBeenCalledWith('slashy', {
      dir: '/repo/cotta',
      limit: 10_000,
      offset: 0,
      includeSystemMessages: true,
    })
  })
})
