import type { ListVersionsEvent, ProjectSessionSearchResponse, ProjectSessionsResponse, ProjectsResponse } from '@cotta/shared'
import type { InfiniteData } from '@tanstack/react-query'
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchProjectsMock, queryProjectSessionsMock } = vi.hoisted(() => ({
  fetchProjectsMock: vi.fn(),
  queryProjectSessionsMock: vi.fn(),
}))

vi.mock('../api', () => ({
  fetchProjects: fetchProjectsMock,
  queryProjectSessions: queryProjectSessionsMock,
}))

import {
  acknowledgeListRefresh,
  createListVersionState,
  markSessionSearchCacheStale,
  planListVersionEvent,
  refreshProjectSessionLists,
  refreshProjectsWindow,
  refreshVisibleProjectSessions,
  relocatedSelectedSession,
  removeProjectSessionFromCache,
  removeSessionFromSearchCache,
  resetSessionSearchCache,
  selectedSessionFromRailCache,
  sessionQueryKeys,
  shouldClearMissingSelection,
} from './session-query-refresh'

const session = (id: string, title: string, projectId: string) => ({ id, title, projectId, occupiedBy: null, occupiedStatus: 'idle' as const, kind: null })
const versionState = (overrides: Partial<Parameters<typeof planListVersionEvent>[0]> = {}) => ({
  epoch: '00000000-0000-4000-8000-000000000001',
  desiredProjectsVersion: 2,
  acknowledgedProjectsVersion: 2,
  desiredProjectVersions: new Map([['p1', 2]]),
  acknowledgedProjectVersions: new Map([['p1', 2]]),
  ...overrides,
})
const versionEvent = (overrides: Partial<ListVersionsEvent> = {}): ListVersionsEvent => ({
  epoch: '00000000-0000-4000-8000-000000000001',
  projectsVersion: 2,
  projectVersions: [],
  sessionVersions: [],
  subagentVersions: [],
  sessionChanges: [],
  ...overrides,
})

describe('list version convergence', () => {
  it('resets stale acknowledgements and refreshes every visible project after an epoch change', () => {
    const plan = planListVersionEvent(
      versionState(),
      versionEvent({
        epoch: '00000000-0000-4000-8000-000000000002',
        projectsVersion: 1,
        projectVersions: [{ projectId: 'p2', version: 1 }],
      }),
      { selectedProjectId: 'p1', selectedSessionId: 's1', visibleProjectIds: ['p2'] },
    )

    expect(plan.state).toMatchObject({ epoch: '00000000-0000-4000-8000-000000000002', desiredProjectsVersion: 1, acknowledgedProjectsVersion: -1 })
    expect([...plan.state.acknowledgedProjectVersions]).toEqual([])
    expect(plan.projectIds).toEqual(['p2', 'p1'])
    expect(plan.refreshProjects).toBe(true)
    expect(plan.refreshPins).toBe(true)
  })

  it('refreshes pinned Project summaries when the projects list version changes', () => {
    const plan = planListVersionEvent(versionState(), versionEvent({ projectsVersion: 3, projectVersions: [{ projectId: 'p1', version: 3 }] }), {
      selectedProjectId: null,
      selectedSessionId: null,
      visibleProjectIds: [],
    })

    expect(plan.refreshProjects).toBe(true)
    expect(plan.refreshPins).toBe(true)
  })

  it('acknowledges an applied epoch refresh for a visible project with implicit version zero', () => {
    const event = versionEvent({ epoch: '00000000-0000-4000-8000-000000000002', projectsVersion: 1 })
    const input = { selectedProjectId: null, selectedSessionId: null, visibleProjectIds: ['p-visible'] }
    const attempted = planListVersionEvent(versionState(), event, input)

    expect(attempted.projectIds).toEqual(['p-visible'])
    acknowledgeListRefresh(attempted.state, attempted.state, {
      sessions: new Map([['p-visible', { outcome: 'applied' }]]),
    })

    expect(attempted.state.acknowledgedProjectVersions.get('p-visible')).toBe(0)
    expect(planListVersionEvent(attempted.state, event, input).projectIds).toEqual([])
  })

  it('plans changed, removed, snapshot, and relocation actions', () => {
    const change = planListVersionEvent(
      versionState(),
      versionEvent({
        projectsVersion: 3,
        projectVersions: [{ projectId: 'p-old', version: 3 }],
        sessionVersions: [{ projectId: 'p-new', sessionId: 's1', version: 'snapshot-v' }],
        sessionChanges: [
          { projectId: 'p-new', sessionId: 's1', kind: 'changed', version: 'change-v', reset: true, invalidateFromTurnId: null },
          { projectId: 'p-old', sessionId: 'removed', kind: 'removed' },
        ],
      }),
      { selectedProjectId: 'p-old', selectedSessionId: 's1', visibleProjectIds: [] },
    )

    expect(change.transcriptSignal).toEqual({ source: 'change', epoch: change.state.epoch, version: 'change-v', reset: true, invalidateFromTurnId: null })
    expect(change.removedSessions).toEqual([{ projectId: 'p-old', sessionId: 'removed', kind: 'removed' }])
    expect(change.selectedSessionProjectIds).toEqual(['p-new'])
    expect(change.projectIds).toEqual(['p-old', 'p-new'])

    const snapshot = planListVersionEvent(
      change.state,
      versionEvent({
        sessionVersions: [{ projectId: 'p-new', sessionId: 's1', version: 'snapshot-v' }],
      }),
      { selectedProjectId: 'p-old', selectedSessionId: 's1', visibleProjectIds: [] },
    )
    expect(snapshot.transcriptSignal).toBeNull()
    expect(snapshot.controlSignal).toEqual({ epoch: snapshot.state.epoch, version: 'snapshot-v' })
    expect(snapshot.refreshPins).toBe(true)

    const reconnect = planListVersionEvent(snapshot.state, versionEvent({ sessionVersions: [{ projectId: 'p-new', sessionId: 's1', version: 'reconnect-v', snapshot: true }] }), {
      selectedProjectId: 'p-old',
      selectedSessionId: 's1',
      visibleProjectIds: [],
    })
    expect(reconnect.transcriptSignal).toEqual({ source: 'snapshot', epoch: reconnect.state.epoch, version: 'reconnect-v', reset: false, invalidateFromTurnId: null })
    expect(reconnect.controlSignal).toBeNull()
    expect(reconnect.selectedSessionProjectIds).toEqual(['p-new'])
    expect(reconnect.projectIds).toEqual(['p-old', 'p-new'])
  })

  it('invalidates selected-session subagents without signaling the transcript', () => {
    const plan = planListVersionEvent(versionState(), versionEvent({ subagentVersions: [{ projectId: 'p1', sessionId: 's1', version: 1 }] }), {
      selectedProjectId: 'p1',
      selectedSessionId: 's1',
      visibleProjectIds: [],
    })

    expect(plan.invalidateSelectedSessionSubagents).toBe(true)
    expect(plan.transcriptSignal).toBeNull()
    expect(plan.controlSignal).toBeNull()
  })

  it('finds relocation from the old owner response without accepting the old owner', () => {
    const relocated = session('s1', 'Moved', 'p-new')
    const outcomes = new Map([['p-old', { outcome: 'applied' as const, selectedSessionExists: false, selectedSessionDetail: relocated }]])

    expect(relocatedSelectedSession(outcomes, 'p-old', 's1')).toEqual(relocated)
    expect(relocatedSelectedSession(outcomes, 'p-new', 's1')).toBeNull()
  })

  it('acknowledges only applied attempts without consuming a pending newer version', () => {
    const attempted = planListVersionEvent(
      createListVersionState(),
      versionEvent({
        projectsVersion: 3,
        projectVersions: [
          { projectId: 'p1', version: 3 },
          { projectId: 'p2', version: 3 },
        ],
      }),
      { selectedProjectId: 'p1', selectedSessionId: null, visibleProjectIds: ['p1', 'p2'] },
    ).state
    const current = planListVersionEvent(
      attempted,
      versionEvent({
        projectsVersion: 4,
        projectVersions: [
          { projectId: 'p1', version: 4 },
          { projectId: 'p2', version: 4 },
        ],
      }),
      { selectedProjectId: 'p1', selectedSessionId: null, visibleProjectIds: ['p1', 'p2'] },
    ).state

    acknowledgeListRefresh(current, attempted, {
      projects: 'applied',
      sessions: new Map([
        ['p1', { outcome: 'applied' }],
        ['p2', { outcome: 'skipped' }],
      ]),
    })

    expect(current.acknowledgedProjectsVersion).toBe(3)
    expect(current.acknowledgedProjectVersions.get('p1')).toBe(3)
    expect(current.acknowledgedProjectVersions.get('p2')).toBeUndefined()
    expect(
      planListVersionEvent(
        current,
        versionEvent({
          projectsVersion: 4,
          projectVersions: [
            { projectId: 'p1', version: 4 },
            { projectId: 'p2', version: 4 },
          ],
        }),
        { selectedProjectId: 'p1', selectedSessionId: null, visibleProjectIds: ['p1', 'p2'] },
      ),
    ).toMatchObject({
      refreshProjects: true,
      projectIds: ['p1', 'p2'],
    })
  })

  it('ignores acknowledgements from an earlier epoch', () => {
    const attempted = versionState()
    const current = planListVersionEvent(attempted, versionEvent({ epoch: '00000000-0000-4000-8000-000000000002', projectsVersion: 1 }), {
      selectedProjectId: 'p1',
      selectedSessionId: null,
      visibleProjectIds: ['p1'],
    }).state

    acknowledgeListRefresh(current, attempted, { projects: 'applied', sessions: new Map([['p1', { outcome: 'applied' }]]) })

    expect(current.acknowledgedProjectsVersion).toBe(-1)
    expect(current.acknowledgedProjectVersions.size).toBe(0)
  })
})

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
        {
          projects: [
            { id: 'p1', name: 'P1' },
            { id: 'p2', name: 'P2' },
          ],
          hasMore: true,
          nextCursor: 'p2',
        },
        { projects: [{ id: 'p3', name: 'P3' }], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'p2'],
    }
    queryClient.setQueryData(sessionQueryKeys.projects, currentProjects)

    const detail: ProjectSessionsResponse = {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's2',
    }
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2), detail)

    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 3), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1'), session('s3', 'S3', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)

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
          sessions: [session('s9', 'S9', 'p1'), session('s8', 'S8', 'p1'), session('s7', 'S7', 'p1')],
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
      sessions: [session('s9', 'S9', 'p1'), session('s8', 'S8', 'p1')],
      defaultSessionId: 's9',
      hasMore: true,
      nextCursor: null,
    })

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 3))).toEqual({
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s9', 'S9', 'p1'), session('s8', 'S8', 'p1'), session('s7', 'S7', 'p1')],
      defaultSessionId: 's9',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('keeps relocated selected-session detail out of the old project cache', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p-old', 1), {
      project: { id: 'p-old', name: 'Old' },
      sessions: [session('old', 'Old session', 'p-old')],
      defaultSessionId: 'old',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    const relocated = session('selected', 'Moved', 'p-new')
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        'p-old': { sessions: [session('old', 'Old session', 'p-old')], selectedSessionExists: false, selectedSessionDetail: relocated, hasMore: false, nextCursor: null },
      },
    })

    const outcomes = await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p-old', selectedSessionId: 'selected' })

    const cached = queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsDetail('p-old', 1))
    expect(cached?.sessions.map(({ id }) => id)).toEqual(['old'])
    expect(outcomes.get('p-old')?.selectedSessionDetail).toEqual(relocated)
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

  it('removes a deleted session from detail and rail window caches', () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)

    removeProjectSessionFromCache(queryClient, 'p1', 's1')

    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsDetail('p1', 2))?.sessions.map((session) => session.id)).toEqual(['s2'])
    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsDetail('p1', 2))?.defaultSessionId).toBe('s2')
    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsRailWindow('p1', 2))?.sessions.map((session) => session.id)).toEqual(['s2'])
    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsRailWindow('p1', 2))?.defaultSessionId).toBe('s2')
  })

  it('marks search queries stale without refetching an active dialog', async () => {
    const key = ['session-search', 'needle']
    const cached = { pages: [], pageParams: [] }
    queryClient.setQueryData(key, cached)
    const queryFn = vi.fn()
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: key,
      queryFn,
      initialPageParam: null as string | null,
      getNextPageParam: () => null,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      markSessionSearchCacheStale(queryClient)
      expect(queryClient.getQueryData(key)).toBe(cached)
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
      expect(queryFn).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('removes a deleted session from active search results and updates exact totals without refetching', () => {
    const key = ['session-search', 'needle']
    const page: ProjectSessionSearchResponse = {
      query: 'needle',
      totalSessions: 2,
      totalMatches: 8,
      hasMore: false,
      nextCursor: null,
      results: [
        {
          project: { id: 'p1', name: 'P1' },
          session: session('s1', 'S1', 'p1'),
          matches: [
            { field: 'title', snippet: 'needle', ranges: [] },
            { field: 'user', snippet: 'needle', ranges: [], locator: { turnId: 't1', messageUuid: 'm1', blockIndex: 0 } },
            { field: 'assistant', snippet: 'needle', ranges: [], locator: { turnId: 't1', messageUuid: 'm2', blockIndex: 0 } },
          ],
          messageMatchCount: 7,
          truncatedMatches: true,
        },
        {
          project: { id: 'p1', name: 'P1' },
          session: session('s2', 'S2', 'p1'),
          matches: [{ field: 'title', snippet: 'needle', ranges: [] }],
          messageMatchCount: 1,
          truncatedMatches: false,
        },
      ],
    }
    queryClient.setQueryData(key, { pages: [page], pageParams: [null] })

    removeSessionFromSearchCache(queryClient, 's1')

    expect(queryClient.getQueryData<InfiniteData<ProjectSessionSearchResponse>>(key)?.pages[0]).toMatchObject({
      totalSessions: 1,
      totalMatches: 1,
      results: [{ session: { id: 's2' } }],
    })
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it('resets every search query so in-flight deleted results cannot return', async () => {
    const page = (query: string, ids: string[]): ProjectSessionSearchResponse => ({
      query,
      totalSessions: 20,
      totalMatches: 50,
      hasMore: true,
      nextCursor: 'old-cursor',
      results: ids.map((id) => ({ project: { id: 'p1', name: 'P1' }, session: session(id, id, 'p1'), matches: [], messageMatchCount: 0, truncatedMatches: false })),
    })
    const activeKey = ['session-search', 'needle']
    const inactiveKey = ['session-search', 'other']
    const unaffectedKey = ['session-search', 'untouched']
    const detailKey = sessionQueryKeys.projectSessionsDetail('p1', 2)
    queryClient.setQueryData(activeKey, { pages: [page('needle', ['s2']), page('needle', ['s1'])], pageParams: [null, 'old-cursor'] })
    queryClient.setQueryData(inactiveKey, { pages: [page('other', ['s1']), page('other', ['s3'])], pageParams: [null, 'old-cursor'] })
    queryClient.setQueryData(unaffectedKey, { pages: [page('untouched', ['s3'])], pageParams: [null] })
    queryClient.setQueryData(detailKey, { project: { id: 'p1', name: 'P1' }, sessions: [session('s1', 'S1', 'p1')], defaultSessionId: 's1', hasMore: false, nextCursor: null })
    const detail = queryClient.getQueryState(detailKey)
    const fresh = { ...page('needle', ['s2']), totalSessions: 7, totalMatches: 31, nextCursor: 'fresh-cursor' }
    const queryFn = vi.fn(async ({ pageParam }: { pageParam: string | null }) => {
      expect(pageParam).toBeNull()
      return fresh
    })
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: activeKey,
      queryFn,
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await resetSessionSearchCache(queryClient)

      expect(queryClient.getQueryData(activeKey)).toEqual({ pages: [fresh], pageParams: [null] })
      expect(queryClient.getQueryData(inactiveKey)).toBeUndefined()
      expect(queryClient.getQueryState(inactiveKey)?.fetchStatus).toBe('idle')
      expect(queryClient.getQueryData(unaffectedKey)).toBeUndefined()
      expect(queryClient.getQueryState(detailKey)).toBe(detail)
      expect(queryFn).toHaveBeenCalledTimes(1)

      await resetSessionSearchCache(queryClient)
      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryData(activeKey)).toEqual({ pages: [fresh], pageParams: [null] })
      expect(queryClient.getQueryData(inactiveKey)).toBeUndefined()
      expect(queryClient.getQueryData(unaffectedKey)).toBeUndefined()
    } finally {
      unsubscribe()
      queryClient.clear()
    }
  })

  it.each([true, false])('does not restore deleted search results from a late request (active: %s)', async (active) => {
    const key = ['session-search', 'needle']
    const oldPage: ProjectSessionSearchResponse = {
      query: 'needle',
      totalSessions: 1,
      totalMatches: 10,
      hasMore: true,
      nextCursor: 'old-cursor',
      results: [{ project: { id: 'p1', name: 'P1' }, session: session('s1', 'S1', 'p1'), matches: [], messageMatchCount: 0, truncatedMatches: false }],
    }
    const fresh = { ...oldPage, totalSessions: 0, totalMatches: 0, results: [], hasMore: false, nextCursor: null }
    queryClient.setQueryData(key, { pages: [oldPage], pageParams: [null] })
    let resolveOld!: (page: ProjectSessionSearchResponse) => void
    const oldRequest = new Promise<ProjectSessionSearchResponse>((resolve) => {
      resolveOld = resolve
    })
    const queryFn = vi.fn<() => Promise<ProjectSessionSearchResponse>>().mockReturnValueOnce(oldRequest).mockResolvedValue(fresh)
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: key,
      queryFn,
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      staleTime: Infinity,
    })
    const unsubscribe = active ? observer.subscribe(() => {}) : () => {}
    try {
      const pending = observer.fetchNextPage()
      expect(queryFn).toHaveBeenCalledTimes(1)

      await resetSessionSearchCache(queryClient)
      const stateAfterReset = queryClient.getQueryState(key)
      expect(queryClient.getQueryData(key)).toEqual(active ? { pages: [fresh], pageParams: [null] } : undefined)
      resolveOld(oldPage)
      await pending
      await oldRequest

      expect(queryClient.getQueryState(key)).toBe(stateAfterReset)
      expect(queryFn).toHaveBeenCalledTimes(active ? 2 : 1)
    } finally {
      unsubscribe()
      queryClient.clear()
    }
  })

  it('cancels an initial search request before it can restore deleted results', async () => {
    const key = ['session-search', 'needle']
    let resolveOld!: (page: ProjectSessionSearchResponse) => void
    const oldRequest = new Promise<ProjectSessionSearchResponse>((resolve) => {
      resolveOld = resolve
    })
    const fresh = { query: 'needle', totalSessions: 0, totalMatches: 0, results: [], hasMore: false, nextCursor: null }
    const queryFn = vi.fn<() => Promise<ProjectSessionSearchResponse>>().mockReturnValueOnce(oldRequest).mockResolvedValue(fresh)
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: key,
      queryFn,
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await vi.waitFor(() => expect(queryClient.getQueryState(key)?.fetchStatus).toBe('fetching'))
      await resetSessionSearchCache(queryClient)
      resolveOld({ query: 'needle', totalSessions: 1, totalMatches: 1, results: [], hasMore: false, nextCursor: null })
      await oldRequest
      expect(queryClient.getQueryData(key)).toEqual({ pages: [fresh], pageParams: [null] })
      expect(queryFn).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      queryClient.clear()
    }
  })

  it('uses configured detail limit when the current detail window is partial', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 10), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's1',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [session('s1', 'S1', 'p1')],
          hasMore: true,
          nextCursor: 's1',
        },
      },
    })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })

    expect(queryProjectSessionsMock).toHaveBeenCalledWith([{ projectId: 'p1', limit: 10 }])
  })

  it('uses configured rail window limit when the current rail window is partial', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 20), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's1',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [session('s1', 'S1', 'p1')],
          hasMore: true,
          nextCursor: 's1',
        },
      },
    })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })

    expect(queryProjectSessionsMock).toHaveBeenCalledWith([{ projectId: 'p1', limit: 20 }])
  })

  it('refreshes the selected project even when it is outside visible project ids', async () => {
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        'p-visible': { sessions: [], hasMore: false, nextCursor: null },
        'p-pinned': {
          sessions: [],
          hasMore: false,
          nextCursor: null,
          selectedSessionExists: true,
          selectedSessionDetail: session('s-pinned', 'Pinned', 'p-pinned'),
        },
      },
    })

    await refreshVisibleProjectSessions(queryClient, {
      selectedProjectId: 'p-pinned',
      selectedSessionId: 's-pinned',
      visibleProjectIds: ['p-visible'],
    })

    expect(queryProjectSessionsMock).toHaveBeenCalledWith([
      { projectId: 'p-pinned', limit: 10, selectedSessionId: 's-pinned' },
      { projectId: 'p-visible', limit: 10 },
    ])
  })

  it('requests selected session detail from extra owner candidates', async () => {
    const selectedSessionDetail = session('s1', 'Moved', 'p-new')
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        'p-old': { sessions: [], hasMore: false, nextCursor: null, selectedSessionExists: true, selectedSessionDetail },
        'p-new': { sessions: [session('s1', 'S1', 'p-new')], hasMore: false, nextCursor: null, selectedSessionExists: true, selectedSessionDetail },
      },
    })

    await expect(
      refreshVisibleProjectSessions(queryClient, {
        selectedProjectId: 'p-old',
        selectedSessionId: 's1',
        selectedSessionProjectIds: ['p-new'],
        visibleProjectIds: [],
      }),
    ).resolves.toEqual(
      new Map([
        ['p-new', { outcome: 'applied', selectedSessionExists: true, selectedSessionDetail }],
        ['p-old', { outcome: 'applied', selectedSessionExists: true, selectedSessionDetail }],
      ]),
    )
    expect(queryProjectSessionsMock).toHaveBeenCalledWith([
      { projectId: 'p-new', limit: 10, selectedSessionId: 's1' },
      { projectId: 'p-old', limit: 10, selectedSessionId: 's1' },
    ])
  })

  it('only protects the exact newly-created selection from temporary absence', () => {
    const selection = { projectId: 'p1', sessionId: 's1' }
    const missing = { outcome: 'applied' as const, selectedSessionExists: false }

    expect(shouldClearMissingSelection(selection, missing, null)).toBe(true)
    expect(shouldClearMissingSelection(selection, missing, selection)).toBe(false)
    expect(shouldClearMissingSelection(selection, missing, { projectId: 'p1', sessionId: 'other' })).toBe(true)
    expect(shouldClearMissingSelection(selection, { outcome: 'applied', selectedSessionExists: true }, selection)).toBe(false)
  })

  it('returns selected-session absence from a refreshed window', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 1), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
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

    await expect(
      refreshVisibleProjectSessions(queryClient, {
        selectedProjectId: 'p1',
        selectedSessionId: 's1',
        visibleProjectIds: ['p1'],
      }),
    ).resolves.toEqual(new Map([['p1', { outcome: 'applied', selectedSessionExists: false }]]))
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
      projects: [
        { id: 'p9', name: 'P9' },
        { id: 'p8', name: 'P8' },
      ],
      hasMore: true,
      nextCursor: 'opaque-new',
    })

    await refreshProjectsWindow(queryClient)

    expect(queryClient.getQueryData(sessionQueryKeys.projects)).toEqual({
      pages: [
        {
          projects: [
            { id: 'p9', name: 'P9' },
            { id: 'p8', name: 'P8' },
          ],
          hasMore: true,
          nextCursor: 'opaque-new',
        },
      ],
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

  it('reads the selected session only from the largest rail window', () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 20), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s11', 'Stale', 'p1')],
      defaultSessionId: 's11',
      hasMore: true,
      nextCursor: 's11',
    } satisfies ProjectSessionsResponse)
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 30), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s11', 'Current', 'p1')],
      defaultSessionId: 's11',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)

    expect(selectedSessionFromRailCache(queryClient, 'p1', 's11')?.title).toBe('Current')
  })

  it('uses the largest populated rail window while a larger window is pending', () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 20), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s11', 'Current', 'p1')],
      defaultSessionId: 's11',
      hasMore: true,
      nextCursor: 's11',
    } satisfies ProjectSessionsResponse)
    queryClient.getQueryCache().build(queryClient, {
      queryKey: sessionQueryKeys.projectSessionsRailWindow('p1', 30),
      queryFn: () => Promise.resolve(undefined),
    })

    expect(selectedSessionFromRailCache(queryClient, 'p1', 's11')?.title).toBe('Current')
  })

  it('does not recover a removed session from an older rail window', () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 20), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s11', 'Stale', 'p1')],
      defaultSessionId: 's11',
      hasMore: true,
      nextCursor: 's11',
    } satisfies ProjectSessionsResponse)
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 30), {
      project: { id: 'p1', name: 'P1' },
      sessions: [],
      defaultSessionId: null,
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)

    expect(selectedSessionFromRailCache(queryClient, 'p1', 's11')).toBeUndefined()
  })

  it('keeps server session order when refreshing the selected session rail', async () => {
    const selectedSessionDetail = session('s-old', 'Old', 'p1')
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 10), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s-old', 'Old', 'p1')],
      defaultSessionId: 's-old',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: { sessions: [session('s-new', 'New', 'p1')], hasMore: true, nextCursor: 's-new', selectedSessionExists: true, selectedSessionDetail },
      },
    })

    await refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', selectedSessionId: 's-old', visibleProjectIds: ['p1'] })

    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsRailWindow('p1', 10))?.sessions.map(({ id }) => id)).toEqual(['s-new', 's-old'])
  })

  it('returns selected session detail even when the session window grows during refresh', async () => {
    const selectedSessionDetail = session('s1', 'Selected session', 'p1')
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 1), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's1',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [session('s9', 'S9', 'p1')],
          hasMore: true,
          nextCursor: 's9',
          selectedSessionExists: true,
          selectedSessionDetail,
        },
      },
    })

    const refresh = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', selectedSessionId: 's1', visibleProjectIds: ['p1'] })
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)

    await expect(refresh).resolves.toEqual(
      new Map([
        [
          'p1',
          {
            outcome: 'skipped',
            selectedSessionExists: true,
            selectedSessionDetail,
          },
        ],
      ]),
    )
  })

  it('does not overwrite sessions loaded while refresh is in flight', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 1), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's1',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [session('s9', 'S9', 'p1')],
          hasMore: true,
          nextCursor: 's9',
        },
      },
    })

    const refresh = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    await refresh

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 2))).toEqual({
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    })
  })

  it('lets disjoint project refreshes both patch their own windows', async () => {
    let resolveP1: (value: unknown) => void
    const p1 = new Promise((resolve) => {
      resolveP1 = resolve
    })
    queryProjectSessionsMock
      .mockImplementationOnce(() => p1 as never)
      .mockResolvedValueOnce({
        sessionsByProject: { p2: { sessions: [session('s2', 'S2', 'p2')], hasMore: false, nextCursor: null } },
      })

    const first = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })
    const second = refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p2', visibleProjectIds: ['p2'] })
    resolveP1!({ sessionsByProject: { p1: { sessions: [session('s1', 'S1', 'p1')], hasMore: false, nextCursor: null } } })

    const [firstOutcomes, secondOutcomes] = await Promise.all([first, second])
    expect(firstOutcomes.get('p1')).toEqual({ outcome: 'applied' })
    expect(secondOutcomes.get('p2')).toEqual({ outcome: 'applied' })
  })

  it('15/17: failed refresh leaves the existing visible session window untouched', async () => {
    const existing = {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 1), existing)
    queryProjectSessionsMock.mockRejectedValue(new Error('connection lost'))

    await expect(refreshVisibleProjectSessions(queryClient, { selectedProjectId: 'p1', visibleProjectIds: ['p1'] })).rejects.toThrow('connection lost')

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 1))).toEqual(existing)
  })

  it('16: epoch-style full refresh reapplies windows without duplicating the selected session', async () => {
    queryClient.setQueryData(sessionQueryKeys.projects, {
      pages: [{ projects: [{ id: 'p1', name: 'P1' }], hasMore: false, nextCursor: null }],
      pageParams: [null],
    } satisfies InfiniteData<ProjectsResponse, string | null>)
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse)
    fetchProjectsMock.mockResolvedValue({ projects: [{ id: 'p1', name: 'P1' }], hasMore: false, nextCursor: null })
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: { sessions: [session('s1', 'S1 new', 'p1'), session('s3', 'S3', 'p1')], hasMore: false, nextCursor: null, selectedSessionExists: true },
      },
    })

    await refreshProjectSessionLists(queryClient, { selectedProjectId: 'p1', selectedSessionId: 's1', visibleProjectIds: ['p1'] })

    expect(queryClient.getQueryData<ProjectSessionsResponse>(sessionQueryKeys.projectSessionsRailWindow('p1', 2))?.sessions.map((item) => item.id)).toEqual(['s1', 's3'])
  })

  it('17: update notifications only request refreshes and do not mutate facts by themselves', () => {
    const existing = {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1')],
      defaultSessionId: 's1',
      hasMore: false,
      nextCursor: null,
    } satisfies ProjectSessionsResponse
    queryClient.setQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 1), existing)

    expect(queryClient.getQueryData(sessionQueryKeys.projectSessionsRailWindow('p1', 1))).toEqual(existing)
    expect(queryProjectSessionsMock).not.toHaveBeenCalled()
  })

  it('refreshes only visible sessions when asked', async () => {
    queryClient.setQueryData(sessionQueryKeys.projectSessionsDetail('p1', 2), {
      project: { id: 'p1', name: 'P1' },
      sessions: [session('s1', 'S1', 'p1'), session('s2', 'S2', 'p1')],
      defaultSessionId: 's1',
      hasMore: true,
      nextCursor: 's2',
    } satisfies ProjectSessionsResponse)
    queryProjectSessionsMock.mockResolvedValue({
      sessionsByProject: {
        p1: {
          sessions: [session('s9', 'S9', 'p1')],
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
