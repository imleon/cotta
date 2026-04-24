import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdkMock = vi.hoisted(() => ({
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  getSessionInfo: vi.fn(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => sdkMock)

import { getMessagesPage, getSession, listSessionsByProjectDir } from './sessions.js'

describe('storage/fs/sessions failure semantics', () => {
  beforeEach(() => {
    sdkMock.getSessionMessages.mockReset()
    sdkMock.listSessions.mockReset()
    sdkMock.getSessionInfo.mockReset()
  })

  it('throws when session message replay fails instead of returning an empty page', async () => {
    sdkMock.getSessionMessages.mockRejectedValue(new Error('jsonl broken'))

    await expect(
      getMessagesPage('session-1', {
        limit: 50,
        projectDirs: ['/tmp/project'],
      }),
    ).rejects.toThrow('Failed to load session messages for session-1: Failed to read persisted session messages: jsonl broken')
  })

  it('throws when no project directories are available instead of returning an empty page', async () => {
    await expect(
      getMessagesPage('session-1', {
        limit: 50,
        projectDirs: [],
      }),
    ).rejects.toThrow('Failed to load session messages for session-1: No project directories available to load session messages')
  })

  it('throws when listing sessions fails instead of returning an empty list', async () => {
    sdkMock.listSessions.mockRejectedValue(new Error('sdk offline'))

    await expect(listSessionsByProjectDir('/tmp/project')).rejects.toThrow(
      'Failed to list sessions for project /tmp/project: sdk offline',
    )
  })

  it('throws when reading session metadata fails instead of returning null', async () => {
    sdkMock.getSessionInfo.mockRejectedValue(new Error('bad json'))

    await expect(getSession('session-1', ['/tmp/project'])).rejects.toThrow(
      'Failed to get session info session-1: Failed to read persisted session info: bad json',
    )
  })
})
