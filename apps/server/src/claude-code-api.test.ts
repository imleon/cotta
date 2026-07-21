import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'

const { listSessionsMock, getSessionMessagesMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').listSessions>(),
  getSessionMessagesMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').getSessionMessages>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: listSessionsMock,
  getSessionMessages: getSessionMessagesMock,
}))

import { createClaudeCodeApi } from './claude-code-api.js'

function projectId(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

function session(overrides: Partial<SDKSessionInfo> & Pick<SDKSessionInfo, 'sessionId' | 'cwd'>): SDKSessionInfo {
  return {
    sessionId: overrides.sessionId,
    cwd: overrides.cwd,
    customTitle: undefined,
    summary: undefined,
    firstPrompt: undefined,
    lastModified: 0,
    fileSize: 0,
    ...overrides,
  }
}

describe('createClaudeCodeApi', () => {
  beforeEach(() => {
    listSessionsMock.mockReset()
    getSessionMessagesMock.mockReset()
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
      sessionCount: 1,
    })
    expect(listSessionsMock).toHaveBeenCalledWith({ dir: '/repo/cotta' })
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
        sessionCount: 2,
      },
      sessions: [
        { id: 'cotta-newer', title: 'cotta-newer', projectId: projectId('/repo/cotta'), lastActivityAt: 5 },
        { id: 'cotta-older', title: 'cotta-older', projectId: projectId('/repo/cotta'), lastActivityAt: 1 },
      ],
      defaultSessionId: 'cotta-newer',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('returns null timeline state for a session that belongs to a sibling worktree path', async () => {
    listSessionsMock.mockResolvedValue([
      session({ sessionId: 'other', cwd: '/repo/cotta-v2', lastModified: 10, fileSize: 99 }),
    ])

    const api = createClaudeCodeApi()

    await expect(api.getSessionTimelineState(projectId('/repo/cotta'), 'other')).resolves.toBeNull()
  })

  it('does not read messages for a session that belongs to a sibling worktree path', async () => {
    listSessionsMock.mockResolvedValue([
      session({ sessionId: 'other', cwd: '/repo/cotta-v2', lastModified: 10 }),
    ])

    const api = createClaudeCodeApi()

    await expect(api.getSessionMessages(projectId('/repo/cotta'), 'other')).resolves.toBeNull()
    expect(getSessionMessagesMock).not.toHaveBeenCalled()
  })

  it('treats trailing slashes as the same project path', async () => {
    listSessionsMock.mockResolvedValue([
      session({ sessionId: 'slashy', cwd: '/repo/cotta/', lastModified: 7 }),
      session({ sessionId: 'other', cwd: '/repo/cotta-v2/', lastModified: 8 }),
    ])
    getSessionMessagesMock.mockResolvedValue([])

    const api = createClaudeCodeApi()

    await expect(api.getProject(projectId('/repo/cotta'))).resolves.toEqual({
      id: projectId('/repo/cotta'),
      name: 'cotta',
      path: '/repo/cotta',
      lastActivityAt: 7,
      sessionCount: 1,
    })
    await expect(api.getSessionMessages(projectId('/repo/cotta'), 'slashy')).resolves.toEqual([])
    expect(getSessionMessagesMock).toHaveBeenCalledWith('slashy', {
      dir: '/repo/cotta',
      limit: 10_000,
      offset: 0,
      includeSystemMessages: true,
    })
  })
})
