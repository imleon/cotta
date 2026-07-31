import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import type { ProjectSessionsResponse, ProjectsResponse } from '@cotta/shared'

const { fetchProjectsMock, queryProjectSessionsMock } = vi.hoisted(() => ({
  fetchProjectsMock: vi.fn(),
  queryProjectSessionsMock: vi.fn(),
}))

vi.mock('./api', () => ({
  fetchProjects: fetchProjectsMock,
  queryProjectSessions: queryProjectSessionsMock,
}))

import { refreshProjectSessionLists, refreshProjectsWindow, refreshVisibleProjectSessions, removeProjectSessionFromCache, sessionQueryKeys } from './session-query-refresh'

const idleRunState = { phase: 'idle' as const, activeUserMessageUuid: null }

describe('refresh helpers', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient()
    fetchProjectsMock.mockReset()
    queryProjectSessionsMock.mockReset()
  })

  it('refreshes loaded windows and repages session rail/detail from one batch response', async () => {
    const currentProjects: InfiniteData<ProjectsResponse, string | null> = {
      pages: [
        { projects: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], hasMore: true, nextCursor: 'p2' },
        { projects: [{ id: 'p3', name: 'P3' }], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'p2'],
    }
    queryClient.setQueryData(sessionQueryKeys.projects, currentProjects)

    const detail: ProjectSessionsResponse = {
      project: { id: 'p1', name: 'P1' },
      sessions: [
        { id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState },
        { id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState },
      ],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's2',
    }
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2), detail)

    const rail: InfiniteData<ProjectSessionsResponse, string | null> = {
      pages: [
        {
          project: { id: 'p1', name: 'P1' },
          sessions: [
            { id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState },
            { id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState },
          ],
          defaultSessionId: 's1',
          hasMore: true,
          nextCursor: 's2',
        },
        {
          project: { id: 'p1', name: 'P1' },
          sessions: [
            { id: 's3', title: 'S3', projectId: 'p1', runState: idleRunState },
          ],
          defaultSessionId: 's1',
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null, 's2'],
    }
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRail('p1'), rail)

    fetchProjectsMock.mockResolvedValue({
      projects: [
        { id: 'p2', name: 'P2-new' },
        { id: 'p1', name: 'P1-new' },
        { id: 'p4', name: 'P4' },
      ],
      hasMore: true,
      nextCursor: 'p4',
    })
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [
            { id: 's9', title: 'S9', projectId: 'p1', runState: idleRunState },
            { id: 's8', title: 'S8', projectId: 'p1', runState: idleRunState },
            { id: 's7', title: 'S7', projectId: 'p1', runState: idleRunState },
          ],
          hasMore: false,
          nextCursor: null,
        },
      },
    })

    await refreshProjectSessionLists(queryClient, {
      selectedProjectId: 'p1',
      visibleProjectIds: ['p1'],
    })

    expect(fetchProjectsMock).toHaveBeenCalledWith(null, 3)
    expect(queryProjectSessionsMock).toHaveBeenCalledWith([{ projectId: 'p1', limit: 3 }])

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2))).toEqual({
      project: { id: 'p1', name: 'P1' },
      sessions: [
        { id: 's9', title: 'S9', projectId: 'p1', runState: idleRunState },
        { id: 's8', title: 'S8', projectId: 'p1', runState: idleRunState },
        { id: 's7', title: 'S7', projectId: 'p1', runState: idleRunState },
      ],
      defaultSessionId: 's9',
      hasMore: false,
      nextCursor: null,
    })

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRail('p1'))).toEqual({
      pages: [{
        project: { id: 'p1', name: 'P1' },
        sessions: [
          { id: 's9', title: 'S9', projectId: 'p1', runState: idleRunState },
          { id: 's8', title: 'S8', projectId: 'p1', runState: idleRunState },
          { id: 's7', title: 'S7', projectId: 'p1', runState: idleRunState },
        ],
        defaultSessionId: 's9',
        hasMore: false,
        nextCursor: null,
      }],
      pageParams: [null],
    })
  })

  it('refreshes only projects when asked', async () => {
    queryClient.setQueryData(sessionQueryKeys.projects, {
      pages: [{ projects: [{ id: 'p1', name: 'P1' }], hasMore: false, nextCursor: null }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectsResponse, string | null>)
    fetchProjectsMock.mockResolvedValue({
      projects: [{ id: 'p2', name: 'P2' }],
      hasMore: false,
      nextCursor: null,
    })

    await refreshProjectsWindow(queryClient)

    expect(fetchProjectsMock).toHaveBeenCalledWith(null, 1)
    expect(queryProjectSessionsMock).not.toHaveBeenCalled()
  })

  it('removes a deleted session from detail and rail caches', () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [
        { id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState },
        { id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState },
      ],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRail('p1'), {
      pages: [{
        project: { id: 'p1', name: 'P1' },
        sessions: [
          { id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState },
          { id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState },
        ],
        defaultSessionId: 's1',
        hasMore: false,
        nextCursor: null,
      }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectSessionsResponse, string | null>)

    removeProjectSessionFromCache(queryClient, 'p1', 's1')

    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsDetail('p1', 2))?.sessions.map((session) => session.id)).toEqual(['s2'])
    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsDetail('p1', 2))?.defaultSessionId).toBe('s2')
    expect(queryClient.getQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(sessionQueryKeys.projectSessionsRail('p1'))?.pages[0]?.sessions.map((session) => session.id)).toEqual(['s2'])
    expect(queryClient.getQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(sessionQueryKeys.projectSessionsRail('p1'))?.pages[0]?.defaultSessionId).toBe('s2')
  })

  it('seeds an empty rail cache from visible session batch response', async () => {
    queryClient.setQueryData(sessionQueryKeys.projects, {
      pages: [{ projects: [{ id: 'p1', name: 'P1' }], hasMore: false, nextCursor: null }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectsResponse, string | null>)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
          hasMore: false,
          nextCursor: null,
        },
      },
    })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRail('p1'))).toEqual({
      pages: [{
        project: { id: 'p1', name: 'P1' },
        sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
        defaultSessionId: 's1',
        hasMore: false,
        nextCursor: null,
      }],
      pageParams: [null],
    })
  })

  it('does not clear an existing rail when batch response omits the project', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRail('p1'), {
      pages: [{
        project: { id: 'p1', name: 'P1' },
        sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
        defaultSessionId: 's1',
        hasMore: true,
        nextCursor: 's1',
      }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectSessionsResponse, string | null>)
    queryProjectSessionsMock.mockResolvedValue({ sessionsByProject: {} })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRail('p1'))).toEqual({
      pages: [{
        project: { id: 'p1', name: 'P1' },
        sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
        defaultSessionId: 's1',
        hasMore: true,
        nextCursor: 's1',
      }],
      pageParams: [null],
    })
  })

  it('uses configured detail limit when the current detail window is partial', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 10), {
      project: { id: 'p1', name: 'P1' },
      sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's1',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
          hasMore: true,
          nextCursor: 's1',
        },
      },
    })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })

    expect(queryProjectSessionsMock).toHaveBeenCalledWith([{ projectId: 'p1', limit: 10 }])
  })

  it('returns selected-session absence from a refreshed window', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 1), {
      project: { id: 'p1', name: 'P1' },
      sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [],
          hasMore: false,
          nextCursor: null,
          selectedSessionExists: false,
        },
      },
    })

    await expect(refreshVisibleProjectSessions(queryClient, {
      selectedProjectId: 'p1',
      selectedSessionId: 's1',
      visibleProjectIds: ['p1'],
    })).resolves.toEqual(new Map([['p1', { outcome: 'applied', selectedSessionExists: false }]]))
  })

  it('collapses refreshed project pages into one latest cursor window', async () => {
    queryClient.setQueryData(sessionQueryKeys.projects, {
      pages: [
        { projects: [{ id: 'p1', name: 'P1' }], hasMore: true, nextCursor: 'opaque-old' },
        { projects: [{ id: 'p2', name: 'P2' }], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'opaque-old'],
    } satisfies InfiniteData<ProjectsResponse, string | null>)
    fetchProjectsMock.mockResolvedValue({
      projects: [{ id: 'p9', name: 'P9' }, { id: 'p8', name: 'P8' }],
      hasMore: true,
      nextCursor: 'opaque-new',
    })

    await refreshProjectsWindow(queryClient)

    expect(queryClient.getQueryData(sessionQueryKeys.projects)).toEqual({
      pages: [{ projects: [{ id: 'p9', name: 'P9' }, { id: 'p8', name: 'P8' }], hasMore: true, nextCursor: 'opaque-new' }],
      pageParams: [null],
    })
  })

  it('does not overwrite projects loaded while refresh is in flight', async () => {
    queryClient.setQueryData(sessionQueryKeys.projects, {
      pages: [{ projects: [{ id: 'p1', name: 'P1' }], hasMore: true, nextCursor: 'p1' }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectsResponse, string | null>)
    fetchProjectsMock.mockResolvedValue({
      projects: [{ id: 'p1', name: 'P1-new' }],
      hasMore: true,
      nextCursor: 'p1',
    })

    const refresh = refreshProjectsWindow(queryClient)
    queryClient.setQueryData(sessionQueryKeys.projects, {
      pages: [
        { projects: [{ id: 'p1', name: 'P1' }], hasMore: true, nextCursor: 'p1' },
        { projects: [{ id: 'p2', name: 'P2' }], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'p1'],
    } satisfies InfiniteData<ProjectsResponse, string | null>)
    await refresh

    expect(queryClient.getQueryData(sessionQueryKeys.projects)).toEqual({
      pages: [
        { projects: [{ id: 'p1', name: 'P1' }], hasMore: true, nextCursor: 'p1' },
        { projects: [{ id: 'p2', name: 'P2' }], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'p1'],
    })
  })

  it('does not overwrite sessions loaded while refresh is in flight', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRail('p1'), {
      pages: [{
        project: { id: 'p1', name: 'P1' },
        sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
        defaultSessionId: 's1',
        hasMore: true,
        nextCursor: 's1',
      }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectSessionsResponse, string | null>)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [{ id: 's9', title: 'S9', projectId: 'p1', runState: idleRunState }],
          hasMore: true,
          nextCursor: 's9',
        },
      },
    })

    const refresh = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRail('p1'), {
      pages: [
        {
          project: { id: 'p1', name: 'P1' },
          sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
          defaultSessionId: 's1',
          hasMore: true,
          nextCursor: 's1',
        },
        {
          project: { id: 'p1', name: 'P1' },
          sessions: [{ id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState }],
          defaultSessionId: 's1',
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null, 's1'],
    } satisfies InfiniteData<ProjectSessionsResponse, string | null>)
    await refresh

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRail('p1'))).toEqual({
      pages: [
        {
          project: { id: 'p1', name: 'P1' },
          sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }],
          defaultSessionId: 's1',
          hasMore: true,
          nextCursor: 's1',
        },
        {
          project: { id: 'p1', name: 'P1' },
          sessions: [{ id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState }],
          defaultSessionId: 's1',
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null, 's1'],
    })
  })

  it('lets disjoint project refreshes both patch their own windows', async () => {
    let resolveP1: (value: unknown) => void
    const p1 = new Promise((resolve) => { resolveP1 = resolve })
    queryProjectSessionsMock.mockImplementationOnce(() => p1 as never).mockResolvedValueOnce({
      sessionsByProject: { p2: { sessions: [{ id: 's2', title: 'S2', projectId: 'p2', runState: idleRunState }], hasMore: false, nextCursor: null } },
    })

    const first = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })
    const second = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p2', visibleProjectIds: ['p2'] })
    resolveP1!({ sessionsByProject: { p1: { sessions: [{ id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState }], hasMore: false, nextCursor: null } } })

    const [firstOutcomes, secondOutcomes] = await Promise.all([first, second])
    expect(firstOutcomes.get('p1')).toEqual({ outcome: 'applied' })
    expect(secondOutcomes.get('p2')).toEqual({ outcome: 'applied' })
  })

  it('refreshes only visible sessions when asked', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [
        { id: 's1', title: 'S1', projectId: 'p1', runState: idleRunState },
        { id: 's2', title: 'S2', projectId: 'p1', runState: idleRunState },
      ],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's2',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [{ id: 's9', title: 'S9', projectId: 'p1', runState: idleRunState }],
          hasMore: false,
          nextCursor: null,
        },
      },
    })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })

    expect(queryProjectSessionsMock).toHaveBeenCalledWith([{ projectId: 'p1', limit: 2 }])
    expect(fetchProjectsMock).not.toHaveBeenCalled()
  })
})
