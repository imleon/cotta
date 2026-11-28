import { describe, expect, it, vi } from 'vitest'
import { createSessionMutationTarget } from './index.js'
import { memoryTranscriptIndex } from './routes/project-routes-test-helpers.js'
import { TranscriptUnavailableError } from './session-raw-transcript-cache.js'
import type { IndexedSession } from './transcript-index-store.js'

describe('createSessionMutationTarget', () => {
  const original = memoryTranscriptIndex().getSession('session-newest')!

  it('waits for synchronization before reading the latest owner and canonical transcript path', async () => {
    let session = { ...original, currentProjectId: 'old-project', transcriptPath: '/old/shard/session.jsonl' }
    const getSession = vi.fn(() => session)
    let finish!: () => void
    const syncTranscript = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            session = { ...session, currentProjectId: 'new-project', transcriptPath: '/canonical/shard/session.jsonl' }
            resolve()
          }
        }),
    )
    const target = createSessionMutationTarget({ transcriptIndex: { getSession }, syncTranscript })
    const pending = target('new-project', original.sessionId)
    expect(getSession).not.toHaveBeenCalled()
    finish()
    await expect(pending).resolves.toEqual({ transcriptPath: '/canonical/shard/session.jsonl' })
    expect(syncTranscript).toHaveBeenCalledWith('new-project', original.sessionId)
    expect(getSession).toHaveBeenCalledWith(original.sessionId)
  })

  it('rejects a stale project after transcript synchronization changes ownership', async () => {
    let session = { ...original, currentProjectId: 'old-project' }
    const target = createSessionMutationTarget({
      transcriptIndex: { getSession: () => session },
      syncTranscript: async () => {
        session = { ...session, currentProjectId: 'new-project' }
      },
    })
    await expect(target('old-project', original.sessionId)).resolves.toBeNull()
  })

  it.each([null, { ...original, isValidSessionId: false }, { ...original, currentProjectId: 'other-project' }, { ...original, transcriptPath: null }] satisfies Array<IndexedSession | null>)(
    'rejects missing, invalid or wrong-project sessions',
    async (session) => {
      const target = createSessionMutationTarget({ transcriptIndex: { getSession: () => session }, syncTranscript: async () => {} })
      await expect(target(original.currentProjectId!, original.sessionId)).resolves.toBeNull()
    },
  )

  it('returns the canonical path without deriving a storage directory from the project', async () => {
    const target = createSessionMutationTarget({
      transcriptIndex: { getSession: () => ({ ...original, transcriptPath: '/unrelated-storage-shard/session.jsonl', currentCwd: '/project/nested/cwd' }) },
      syncTranscript: async () => {},
    })
    await expect(target(original.currentProjectId!, original.sessionId)).resolves.toEqual({ transcriptPath: '/unrelated-storage-shard/session.jsonl' })
  })

  it('returns null when transcript synchronization reports the session transcript is unavailable', async () => {
    const getSession = vi.fn(() => original)
    const target = createSessionMutationTarget({
      transcriptIndex: { getSession },
      syncTranscript: async () => {
        throw new TranscriptUnavailableError(original.sessionId)
      },
    })
    await expect(target(original.currentProjectId!, original.sessionId)).resolves.toBeNull()
    expect(getSession).not.toHaveBeenCalled()
  })

  it('propagates synchronization failures without using stale index data', async () => {
    const error = new Error('unreadable transcript')
    const getSession = vi.fn(() => original)
    const target = createSessionMutationTarget({
      transcriptIndex: { getSession },
      syncTranscript: async () => {
        throw error
      },
    })
    await expect(target(original.currentProjectId!, original.sessionId)).rejects.toBe(error)
    expect(getSession).not.toHaveBeenCalled()
  })
})
