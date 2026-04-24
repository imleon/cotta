import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const sessionStore = {
  sessions: [],
  fetchSessions: vi.fn().mockResolvedValue(false),
  authToken: '',
}

const fetchAgentsRequest = vi.fn()
const fetchSdkRawLogsRequest = vi.fn()
const fetchPersistentLogsRequest = vi.fn()

vi.mock('../api/agents', () => ({
  fetchAgentsRequest,
}))

vi.mock('../api/logs', () => ({
  fetchSdkRawLogsRequest,
  fetchPersistentLogsRequest,
}))

vi.mock('./session', () => ({
  useSessionStore: () => sessionStore,
}))

vi.mock('../api/http', () => ({
  apiFetch: vi.fn(),
}))

describe('log-view store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStore.sessions = []
    sessionStore.fetchSessions.mockResolvedValue(false)
    sessionStore.authToken = ''
    fetchAgentsRequest.mockReset().mockResolvedValue({
      ok: true,
      data: {
        agents: [],
        defaultAgentId: null,
      },
    })
    fetchSdkRawLogsRequest.mockReset()
    fetchPersistentLogsRequest.mockReset().mockResolvedValue({
      ok: true,
      data: {
        items: [],
        hasMore: false,
        nextCursor: null,
      },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads older sdk raw log pages and preserves ascending cursor order', async () => {
    const { useLogViewStore } = await import('./log-view')
    const store = useLogViewStore()
    store.logLive = false

    fetchSdkRawLogsRequest
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [
            { cursor: 3, runId: 'run-1', loggedAt: 3, sessionId: 'session-1', event: { kind: 'sdk_message' } },
            { cursor: 4, runId: 'run-1', loggedAt: 4, sessionId: 'session-1', event: { kind: 'sdk_message' } },
          ],
          hasMore: true,
          nextCursor: 2,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [
            { cursor: 1, runId: 'run-1', loggedAt: 1, sessionId: 'session-1', event: { kind: 'sdk_message' } },
            { cursor: 2, runId: 'run-1', loggedAt: 2, sessionId: 'session-1', event: { kind: 'sdk_message' } },
          ],
          hasMore: false,
          nextCursor: null,
        },
      })

    store.selectedSessionId = 'session-1'
    await Promise.resolve()
    await Promise.resolve()

    expect(store.sdkRawLog.map((item) => item.cursor)).toEqual([3, 4])
    expect(store.sdkRawLogHasMore).toBe(true)

    await store.loadOlderSdkRawLogs()

    expect(store.sdkRawLog.map((item) => item.cursor)).toEqual([1, 2, 3, 4])
    expect(store.sdkRawLogHasMore).toBe(false)
    expect(store.sdkRawLogLoading).toBe(false)
    expect(fetchSdkRawLogsRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      'session-1',
      expect.objectContaining({
        cursor: 2,
        follow: undefined,
      }),
    )
  })
})
