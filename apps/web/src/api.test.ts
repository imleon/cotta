import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryProjectSessions } from './api'

describe('queryProjectSessions', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts a fresh request for an identical payload', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(Promise.all([
      queryProjectSessions([{ projectId: 'p1', limit: 10 }]),
      queryProjectSessions([{ projectId: 'p1', limit: 10 }]),
    ])).resolves.toEqual([
      { sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } },
      { sessionsByProject: { p1: { sessions: [], hasMore: false, nextCursor: null } } },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries after an in-flight request fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionsByProject: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(queryProjectSessions([{ projectId: 'p1', limit: 10 }])).rejects.toThrow('Project sessions query failed: 500')
    await expect(queryProjectSessions([{ projectId: 'p1', limit: 10 }])).resolves.toEqual({ sessionsByProject: {} })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
