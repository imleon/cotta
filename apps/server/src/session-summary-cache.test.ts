import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk'

const { listSessionsMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').listSessions>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: listSessionsMock,
}))

import { SessionSummaryCache } from './session-summary-cache.js'

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

function projectId(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url')
}

describe('SessionSummaryCache', () => {
  beforeEach(() => {
    listSessionsMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts background refresh after initial warm-up fails', async () => {
    vi.useFakeTimers()
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockRejectedValueOnce(new Error('startup unavailable'))
      .mockResolvedValueOnce([])

    await expect(cache.ensureReady()).rejects.toThrow('startup unavailable')
    await vi.advanceTimersByTimeAsync(15_000)

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
  })

  it('includes live status in cached session windows', async () => {
    const cache = new SessionSummaryCache(10)
    cache.setSessionStateReader((sessionId) => sessionId === 's1' ? 'running' : null)
    listSessionsMock.mockResolvedValueOnce([
      session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 }),
    ])

    await cache.scheduleRefresh()

    expect(await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })).toEqual({
      sessionsByProject: {
        [projectId('/repo/a')]: {
          sessions: [{ id: 's1', title: 's1', projectId: projectId('/repo/a'), lastActivityAt: 5, rawStatus: 'running', displayStatus: 'running' }],
          hasMore: false,
          nextCursor: null,
        },
      },
    })
  })

  it('keeps age and ordering stable when only the session mtime changes', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 'newer', cwd: '/repo/a', lastModified: 200, fileSize: 20 }),
        session({ sessionId: 'older', cwd: '/repo/a', lastModified: 100, fileSize: 10 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'older', cwd: '/repo/a', lastModified: 300, fileSize: 10 }),
        session({ sessionId: 'newer', cwd: '/repo/a', lastModified: 200, fileSize: 20 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'older', cwd: '/repo/a', lastModified: 400, fileSize: 11 }),
        session({ sessionId: 'newer', cwd: '/repo/a', lastModified: 200, fileSize: 20 }),
      ])

    await cache.scheduleRefresh()
    await cache.scheduleRefresh()

    expect(await cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).toMatchObject({
      project: { lastActivityAt: 200 },
      sessions: [
        { id: 'newer', lastActivityAt: 200 },
        { id: 'older', lastActivityAt: 100 },
      ],
    })

    await cache.scheduleRefresh()

    expect(await cache.listProjectSessions(projectId('/repo/a'), { limit: 10 })).toMatchObject({
      project: { lastActivityAt: 400 },
      sessions: [
        { id: 'older', lastActivityAt: 400 },
        { id: 'newer', lastActivityAt: 200 },
      ],
    })
  })

  it('keeps visible activity across a full rebuild', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 'old', cwd: '/repo/a', lastModified: 100, fileSize: 10 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'old', cwd: '/repo/a', lastModified: 200, fileSize: 10 }),
      ])

    await cache.scheduleRefresh()
    await cache.getProject(projectId('/missing'))

    await expect(cache.getProject(projectId('/repo/a'))).resolves.toMatchObject({ lastActivityAt: 100 })
  })

  it('moves a session between projects and emits versions for both projects', async () => {
    const cache = new SessionSummaryCache(10)
    const events: Array<{ projectsVersion: number; projectVersions: Array<{ projectId: string; version: number }> }> = []
    cache.subscribe((event) => events.push(event))
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 })])
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/b', lastModified: 6 })])

    await cache.scheduleRefresh()
    await cache.scheduleRefresh()

    expect(await cache.queryProjectSessions({ projects: [
      { projectId: projectId('/repo/a'), limit: 10 },
      { projectId: projectId('/repo/b'), limit: 10 },
    ] })).toEqual({
      sessionsByProject: {
        [projectId('/repo/b')]: {
          sessions: [{ id: 's1', title: 's1', projectId: projectId('/repo/b'), lastActivityAt: 5 }],
          hasMore: false,
          nextCursor: null,
        },
      },
    })
    expect(events.at(-1)?.projectVersions.map((project) => project.projectId).sort()).toEqual([projectId('/repo/a'), projectId('/repo/b')].sort())
  })

  it('short-circuits load more after project is fully loaded', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 })])
      .mockResolvedValueOnce([])

    await cache.scheduleRefresh()
    await cache.scheduleRefresh()

    const firstPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 1 })
    const beforeCalls = listSessionsMock.mock.calls.length
    await cache.listProjectSessions(projectId('/repo/a'), { limit: 10, cursor: firstPage?.nextCursor })

    expect(listSessionsMock.mock.calls.length).toBe(beforeCalls)
  })

  it('prunes sessions absent from an authoritative project backfill', async () => {
    const cache = new SessionSummaryCache(2)
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 }),
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 }),
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 }),
      ])
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])

    await cache.scheduleRefresh()
    const firstPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 1 })
    const nextPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 2, cursor: firstPage?.nextCursor })

    expect(nextPage?.sessions.map((session) => session.id)).toEqual([])
    expect(nextPage?.hasMore).toBe(false)
  })

  it('publishes a version after an authoritative project backfill', async () => {
    const cache = new SessionSummaryCache(1)
    const events: Array<{ projectVersions: Array<{ projectId: string }> }> = []
    cache.subscribe((event) => events.push(event))
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 })])
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 }),
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 }),
        session({ sessionId: 's3', cwd: '/repo/a', lastModified: 1 }),
      ])

    await cache.scheduleRefresh()
    const firstPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 1 })
    const eventCount = events.length
    const secondPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 10, cursor: firstPage?.nextCursor })

    expect(secondPage?.sessions.map((session) => session.id)).toEqual(['s2', 's3'])
    expect(events).toHaveLength(eventCount + 1)
    expect(events.at(-1)?.projectVersions.map((project) => project.projectId)).toContain(projectId('/repo/a'))
  })

  it('serializes concurrent project backfills', async () => {
    let resolveBackfill: ((sessions: SDKSessionInfo[]) => void) | undefined
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 })])
      .mockImplementationOnce(() => new Promise<SDKSessionInfo[]>((resolve) => { resolveBackfill = resolve }))

    await cache.scheduleRefresh()
    const firstPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 1 })
    const firstBackfill = cache.listProjectSessions(projectId('/repo/a'), { limit: 10, cursor: firstPage?.nextCursor })
    await vi.waitFor(() => expect(resolveBackfill).toBeTypeOf('function'))
    const secondBackfill = cache.listProjectSessions(projectId('/repo/a'), { limit: 10, cursor: firstPage?.nextCursor })
    resolveBackfill?.([
      session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 }),
      session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 }),
      session({ sessionId: 's3', cwd: '/repo/a', lastModified: 1 }),
    ])

    await expect(Promise.all([firstBackfill, secondBackfill])).resolves.toHaveLength(2)
    expect(listSessionsMock.mock.calls.filter(([options]) => options?.dir === '/repo/a')).toHaveLength(1)
  })

  it('backfills an undersized project window before reporting hasMore', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/b', lastModified: 2 })])
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])

    await cache.scheduleRefresh()

    await expect(cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })).resolves.toEqual({
      sessionsByProject: {
        [projectId('/repo/a')]: {
          sessions: [{ id: 's1', title: 's1', projectId: projectId('/repo/a'), lastActivityAt: 3 }],
          hasMore: false,
          nextCursor: null,
        },
      },
    })
    expect(listSessionsMock.mock.calls.filter(([options]) => options?.dir === '/repo/a')).toHaveLength(1)
  })

  it('does not report a selected session missing from a partial cache', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 })])

    await cache.scheduleRefresh()

    await expect(cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 1, selectedSessionId: 'missing' }] })).resolves.toEqual({
      sessionsByProject: {
        [projectId('/repo/a')]: {
          sessions: [{ id: 's1', title: 's1', projectId: projectId('/repo/a'), lastActivityAt: 3 }],
          hasMore: true,
          nextCursor: expect.any(String),
        },
      },
    })
  })

  it('reports a selected session missing only after the project cache is complete', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([])

    await cache.scheduleRefresh()

    await expect(cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 1, selectedSessionId: 'missing' }] })).resolves.toMatchObject({
      sessionsByProject: {
        [projectId('/repo/a')]: {
          hasMore: false,
          selectedSessionExists: false,
        },
      },
    })
  })

  it('keeps same-timestamp sessions outside a partial scan boundary', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 10 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 9 })])
      .mockResolvedValueOnce([session({ sessionId: 's3', cwd: '/repo/a', lastModified: 9 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 10 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 9 })])
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 10 }),
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 9 }),
        session({ sessionId: 's3', cwd: '/repo/a', lastModified: 9 }),
      ])

    await cache.ensureReady()
    await cache.scheduleRefresh()

    expect((await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })).sessionsByProject[projectId('/repo/a')]?.sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3'])
  })

  it('marks project sessions incomplete after a shallow refresh stops before the end', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 })])

    await cache.ensureReady()
    await cache.scheduleRefresh()

    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 2 })).resolves.toMatchObject({ hasMore: true })
  })

  it('rejects a session cursor after its sorted prefix changes', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 }),
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 2 }),
        session({ sessionId: 's3', cwd: '/repo/a', lastModified: 1 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 4, fileSize: 1 }),
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 3 }),
        session({ sessionId: 's3', cwd: '/repo/a', lastModified: 1 }),
      ])

    await cache.scheduleRefresh()
    const firstPage = await cache.listProjectSessions(projectId('/repo/a'), { limit: 2 })
    await cache.scheduleRefresh()

    await expect(cache.listProjectSessions(projectId('/repo/a'), { limit: 2, cursor: firstPage?.nextCursor })).rejects.toMatchObject({ code: 'stale' })
  })

  it('does not bump versions on no-op refresh', async () => {
    const cache = new SessionSummaryCache(10)
    const events: Array<{ projectsVersion: number; projectVersions: Array<{ projectId: string; version: number }> }> = []
    cache.subscribe((event) => events.push(event))
    listSessionsMock.mockResolvedValue([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 })])

    await cache.scheduleRefresh()
    const versionsAfterFirst = { projectsVersion: cache.projectsVersion, projectVersion: cache.getProjectVersion(projectId('/repo/a')) }
    await cache.scheduleRefresh()

    expect(cache.projectsVersion).toBe(versionsAfterFirst.projectsVersion)
    expect(cache.getProjectVersion(projectId('/repo/a'))).toBe(versionsAfterFirst.projectVersion)
    expect(events).toHaveLength(1)
  })

  it('removes sessions that disappear from a fully covered refresh window', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 's1', cwd: '/repo/a', lastModified: 6 }),
        session({ sessionId: 's2', cwd: '/repo/a', lastModified: 5 }),
      ])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 5 })])

    await cache.scheduleRefresh()
    await cache.scheduleRefresh()

    const refreshed = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })
    expect(refreshed.sessionsByProject[projectId('/repo/a')]?.sessions).toEqual([
      { id: 's2', title: 's2', projectId: projectId('/repo/a'), lastActivityAt: 5 },
    ])
  })

  it('does not mutate cache when a multi-page refresh fails before completion', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 6 })])
      .mockRejectedValueOnce(new Error('boom'))

    await cache.scheduleRefresh()
    await expect(cache.scheduleRefresh()).rejects.toThrow('boom')

    const unchanged = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })
    expect(unchanged.sessionsByProject[projectId('/repo/a')]?.sessions).toEqual([
      { id: 's1', title: 's1', projectId: projectId('/repo/a'), lastActivityAt: 5 },
    ])
  })

  it('returns session windows larger than 100', async () => {
    const cache = new SessionSummaryCache(200)
    listSessionsMock.mockResolvedValueOnce(Array.from({ length: 101 }, (_, index) => session({
      sessionId: `s${index}`,
      cwd: '/repo/a',
      lastModified: 200 - index,
    })))

    await cache.scheduleRefresh()

    const window = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 101 }] })
    expect(window.sessionsByProject[projectId('/repo/a')]?.sessions).toHaveLength(101)
  })

  it('exposes a process epoch with its version snapshot', () => {
    const cache = new SessionSummaryCache(10)

    expect(cache.versionSnapshot).toEqual({
      epoch: expect.any(String),
      projectsVersion: 0,
      projectVersions: [],
    })
  })

  it('discovers a cold valid project before serving a batch session window', async () => {
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 'a1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 'b1', cwd: '/repo/b', lastModified: 2 })])
      .mockResolvedValueOnce([session({ sessionId: 'a1', cwd: '/repo/a', lastModified: 3 })])
      .mockResolvedValueOnce([session({ sessionId: 'b1', cwd: '/repo/b', lastModified: 2 })])
      .mockResolvedValueOnce([session({ sessionId: 'c1', cwd: '/repo/c', lastModified: 1 })])
      .mockResolvedValueOnce([])

    await cache.scheduleRefresh()
    const response = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/c'), limit: 10 }] })

    expect(response.sessionsByProject[projectId('/repo/c')]?.sessions).toEqual([
      { id: 'c1', title: 'c1', projectId: projectId('/repo/c'), lastActivityAt: 1 },
    ])
  })

  it('runs a pending deep refresh after the active shallow refresh fails', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockImplementationOnce(() => new Promise<SDKSessionInfo[]>((_, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 2 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 1 })])
      .mockResolvedValueOnce([])

    const shallow = cache.scheduleRefresh()
    const deep = cache.listProjects({ limit: 2 })
    rejectFirst?.(new Error('boom'))

    await expect(shallow).rejects.toThrow('boom')
    await expect(deep).rejects.toThrow('boom')
    const recovered = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })
    expect(recovered.sessionsByProject[projectId('/repo/a')]?.sessions.map((session) => session.id)).toEqual(['s1', 's2'])
  })

  it('passes includeProgrammatic true when scanning sessions', async () => {
    const cache = new SessionSummaryCache(10)
    listSessionsMock.mockResolvedValueOnce([])

    await cache.scheduleRefresh()

    expect(listSessionsMock).toHaveBeenCalledWith(expect.objectContaining({ includeProgrammatic: true }))
  })

  it('removes a project when its last session disappears from a covered refresh', async () => {
    const cache = new SessionSummaryCache(10)
    const events: Array<{ projectsVersion: number; projectVersions: Array<{ projectId: string; version: number }> }> = []
    cache.subscribe((event) => events.push(event))
    listSessionsMock
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 })])
      .mockResolvedValueOnce([])

    await cache.scheduleRefresh()
    await cache.scheduleRefresh()

    await expect(cache.listProjects({ limit: 10 })).resolves.toEqual({ projects: [], hasMore: false, nextCursor: null })
    expect(events.at(-1)?.projectVersions.map((project) => project.projectId)).toContain(projectId('/repo/a'))
  })

  it('rescans from the head for deep project-window extension so inserted sessions are not skipped', async () => {
    const cache = new SessionSummaryCache(2)
    listSessionsMock
      .mockResolvedValueOnce([
        session({ sessionId: 'a1', cwd: '/repo/a', lastModified: 10 }),
        session({ sessionId: 'a2', cwd: '/repo/a', lastModified: 9 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'a3', cwd: '/repo/a', lastModified: 8 }),
        session({ sessionId: 'a4', cwd: '/repo/a', lastModified: 7 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'n1', cwd: '/repo/n', lastModified: 13 }),
        session({ sessionId: 'n2', cwd: '/repo/n', lastModified: 12 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'n3', cwd: '/repo/n', lastModified: 11 }),
        session({ sessionId: 'a1', cwd: '/repo/a', lastModified: 10 }),
      ])
      .mockResolvedValueOnce([
        session({ sessionId: 'a2', cwd: '/repo/a', lastModified: 9 }),
        session({ sessionId: 'a3', cwd: '/repo/a', lastModified: 8 }),
      ])
      .mockResolvedValueOnce([session({ sessionId: 'a4', cwd: '/repo/a', lastModified: 7 })])

    await cache.scheduleRefresh()
    await cache.listProjects({ limit: 5 })

    const inserted = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/n'), limit: 10 }] })
    expect(inserted.sessionsByProject[projectId('/repo/n')]?.sessions.map((session) => session.id)).toEqual(['n1', 'n2', 'n3'])
    expect(listSessionsMock.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ offset: 0 }))
  })

  it('runs pending deep refresh instead of downgrading it to shallow refresh', async () => {
    let releaseFirstScan: ((sessions: SDKSessionInfo[]) => void) | undefined
    const cache = new SessionSummaryCache(1)
    listSessionsMock
      .mockImplementationOnce(() => new Promise<SDKSessionInfo[]>((resolve) => { releaseFirstScan = resolve }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 2 })])
      .mockResolvedValueOnce([session({ sessionId: 's2', cwd: '/repo/a', lastModified: 1 })])
      .mockResolvedValueOnce([])

    const shallow = cache.scheduleRefresh()
    const deep = cache.listProjects({ limit: 2 })
    releaseFirstScan?.([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 2 })])

    await shallow
    await expect(deep).resolves.toEqual({
      projects: [{ id: projectId('/repo/a'), name: 'a', path: '/repo/a', lastActivityAt: 2 }],
      hasMore: false,
      nextCursor: null,
    })
    const deepWindow = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })
    expect(deepWindow.sessionsByProject[projectId('/repo/a')]?.sessions.map((session) => session.id)).toEqual(['s1', 's2'])
  })

  it('bumps only project session version for status-only changes', async () => {
    let state: string | null = null
    const cache = new SessionSummaryCache(10)
    const events: Array<{ projectsVersion: number; projectVersions: Array<{ projectId: string; version: number }> }> = []
    cache.setSessionStateReader(() => state)
    cache.subscribe((event) => events.push(event))
    listSessionsMock.mockResolvedValue([session({ sessionId: 's1', cwd: '/repo/a', lastModified: 5 })])

    await cache.scheduleRefresh()
    state = 'running'
    await cache.scheduleRefresh()

    expect(events.at(-1)).toEqual(expect.objectContaining({
      epoch: expect.any(String),
      projectsVersion: 1,
      projectVersions: [{ projectId: projectId('/repo/a'), version: 2 }],
    }))
    const statusWindow = await cache.queryProjectSessions({ projects: [{ projectId: projectId('/repo/a'), limit: 10 }] })
    expect(statusWindow.sessionsByProject[projectId('/repo/a')]?.sessions[0]).toEqual({
      id: 's1',
      title: 's1',
      projectId: projectId('/repo/a'),
      lastActivityAt: 5,
      rawStatus: 'running',
      displayStatus: 'running',
    })
  })
})
