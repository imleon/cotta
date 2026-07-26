import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, fetchProjects, PaginationCursorStaleError, queryProjectSessions } from './api'

describe('createProject', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '?token=secret' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a project with the authenticated API contract', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ project: { id: 'p1', name: 'demo', path: '/home/demo' } }), { status: 201 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createProject('experiments/demo')).resolves.toEqual({ project: { id: 'p1', name: 'demo', path: '/home/demo' } })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects?token=secret', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ directoryPath: 'experiments/demo' }),
    }))
  })

  it('surfaces project creation failures with their error code', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'project_already_exists' }), { status: 409 }))))

    await expect(createProject('demo')).rejects.toMatchObject({
      status: 409,
      code: 'project_already_exists',
    })
  })
})

describe('fetchProjects', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost', search: '' } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a stale cursor response to PaginationCursorStaleError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'pagination_cursor_stale' }), { status: 409 }))))

    await expect(fetchProjects('stale')).rejects.toBeInstanceOf(PaginationCursorStaleError)
  })
})

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
