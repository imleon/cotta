import type { ListVersionsEvent, ProjectSessionSearchResponse, ProjectSessionsQueryResponse, ProjectSessionsResponse, ProjectSessionsWindow, ProjectsResponse, SessionSummary } from '@cotta/shared'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { fetchProjects, queryProjectSessions } from '../api'
import type { TimelineControlSignal, TranscriptSignal } from '../timeline/core'

export const sessionQueryKeys = {
  projects: ['projects'] as const,
  sessionPins: ['session-pins'] as const,
  projectSessionsDetail: (projectId: string | null, sessionLimit: number, selectedSessionId: string | null = null) => ['project-sessions-detail', projectId, sessionLimit, selectedSessionId] as const,
  projectSessionsRailWindow: (projectId: string, limit: number) => ['project-sessions-rail-window', projectId, limit] as const,
  sessionTimeline: (sessionId: string, anchorTurnId: string | null) => ['session-timeline', sessionId, anchorTurnId] as const,
}

export type ListVersionState = {
  epoch: string | null
  desiredProjectsVersion: number
  acknowledgedProjectsVersion: number
  desiredProjectVersions: Map<string, number>
  acknowledgedProjectVersions: Map<string, number>
}

export function createListVersionState(): ListVersionState {
  return {
    epoch: null,
    desiredProjectsVersion: 0,
    acknowledgedProjectsVersion: -1,
    desiredProjectVersions: new Map(),
    acknowledgedProjectVersions: new Map(),
  }
}

export function planListVersionEvent(current: ListVersionState, event: ListVersionsEvent, input: { selectedProjectId: string | null; selectedSessionId: string | null; visibleProjectIds: string[] }) {
  const epochChanged = current.epoch !== event.epoch
  const desiredProjectVersions = epochChanged ? new Map<string, number>() : new Map(current.desiredProjectVersions)
  const acknowledgedProjectVersions = epochChanged ? new Map<string, number>() : new Map(current.acknowledgedProjectVersions)
  const desiredProjectsVersion = Math.max(epochChanged ? 0 : current.desiredProjectsVersion, event.projectsVersion)
  const acknowledgedProjectsVersion = epochChanged ? -1 : current.acknowledgedProjectsVersion
  for (const { projectId, version } of event.projectVersions) {
    desiredProjectVersions.set(projectId, Math.max(desiredProjectVersions.get(projectId) ?? 0, version))
  }
  const selectedChange = input.selectedSessionId ? event.sessionChanges.find((change) => change.kind === 'changed' && change.sessionId === input.selectedSessionId) : undefined
  const selectedSnapshot = !selectedChange && input.selectedSessionId ? event.sessionVersions.find((snapshot) => snapshot.sessionId === input.selectedSessionId) : undefined
  const invalidateSelectedSessionSubagents = input.selectedSessionId ? event.subagentVersions.some(({ sessionId }) => sessionId === input.selectedSessionId) : false
  const transcriptSignal: TranscriptSignal | null =
    selectedChange?.kind === 'changed'
      ? { source: 'change', epoch: event.epoch, version: selectedChange.version, reset: selectedChange.reset, invalidateFromTurnId: selectedChange.invalidateFromTurnId }
      : selectedSnapshot?.snapshot
        ? { source: 'snapshot', epoch: event.epoch, version: selectedSnapshot.version, reset: false, invalidateFromTurnId: null }
        : null
  const controlSignal: TimelineControlSignal | null = selectedSnapshot && !selectedSnapshot.snapshot ? { epoch: event.epoch, version: selectedSnapshot.version } : null
  const selectedSessionProjectIds = input.selectedSessionId
    ? [
        ...new Set([
          ...event.sessionChanges.flatMap((change) => (change.kind === 'changed' && change.sessionId === input.selectedSessionId ? [change.projectId] : [])),
          ...event.sessionVersions.flatMap((snapshot) => (snapshot.sessionId === input.selectedSessionId ? [snapshot.projectId] : [])),
        ]),
      ]
    : []
  const projectIds = [
    ...new Set([
      ...(input.selectedProjectId ? [...input.visibleProjectIds, input.selectedProjectId] : input.visibleProjectIds).filter(
        (projectId) => epochChanged || (desiredProjectVersions.get(projectId) ?? 0) > (acknowledgedProjectVersions.get(projectId) ?? -1),
      ),
      ...selectedSessionProjectIds,
    ]),
  ]
  return {
    state: { epoch: event.epoch, desiredProjectsVersion, acknowledgedProjectsVersion, desiredProjectVersions, acknowledgedProjectVersions },
    refreshProjects: epochChanged || desiredProjectsVersion > acknowledgedProjectsVersion,
    refreshPins: epochChanged || event.projectsVersion > current.acknowledgedProjectsVersion || event.sessionChanges.length > 0 || event.sessionVersions.length > 0,
    removedSessions: event.sessionChanges.flatMap((change) => (change.kind === 'removed' ? [change] : [])),
    transcriptSignal,
    controlSignal,
    invalidateSelectedSessionSubagents,
    selectedSessionProjectIds,
    projectIds,
  }
}

const projectRefreshGenerations = new WeakMap<QueryClient, number>()
const sessionRefreshGenerations = new WeakMap<QueryClient, Map<string, number>>()

export type RefreshOutcome = 'applied' | 'skipped' | 'missing'

export type ProjectRefreshResult = {
  outcome: RefreshOutcome
  selectedSessionExists?: boolean
  selectedSessionDetail?: SessionSummary | null
}

export function acknowledgeListRefresh(state: ListVersionState, attempted: ListVersionState, input: { projects?: RefreshOutcome; sessions?: Map<string, ProjectRefreshResult> }): void {
  if (state.epoch !== attempted.epoch) return
  if (input.projects === 'applied') {
    state.acknowledgedProjectsVersion = Math.max(state.acknowledgedProjectsVersion, attempted.desiredProjectsVersion)
  }
  for (const [projectId, outcome] of input.sessions ?? []) {
    if (outcome.outcome !== 'applied') continue
    const attemptedVersion = attempted.desiredProjectVersions.get(projectId) ?? 0
    state.acknowledgedProjectVersions.set(projectId, Math.max(state.acknowledgedProjectVersions.get(projectId) ?? -1, attemptedVersion))
  }
}

export function relocatedSelectedSession(outcomes: Map<string, ProjectRefreshResult>, selectedProjectId: string, selectedSessionId: string): SessionSummary | null {
  return [...outcomes.values()].map((outcome) => outcome.selectedSessionDetail).find((session) => session?.id === selectedSessionId && session.projectId !== selectedProjectId) ?? null
}

export function shouldClearMissingSelection(
  selection: { projectId: string; sessionId: string },
  outcome: ProjectRefreshResult | undefined,
  pendingCreatedSelection: { projectId: string; sessionId: string } | null,
): boolean {
  return (
    outcome?.outcome === 'applied' &&
    outcome.selectedSessionExists === false &&
    (pendingCreatedSelection?.projectId !== selection.projectId || pendingCreatedSelection.sessionId !== selection.sessionId)
  )
}

export function selectedSessionFromRailCache(queryClient: QueryClient, projectId: string | null, sessionId: string | null): SessionSummary | undefined {
  if (!projectId || !sessionId) return undefined
  const window = queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-rail-window', projectId] }).reduce<{ limit: number; data?: ProjectSessionsResponse }>(
    (best, [queryKey, data]) => {
      const limit = typeof queryKey[2] === 'number' ? queryKey[2] : 0
      return data && limit > best.limit ? { limit, data } : best
    },
    { limit: -1 },
  ).data
  return window?.sessions.find((session) => session.id === sessionId)
}

function nextRefreshGeneration(store: WeakMap<QueryClient, number>, queryClient: QueryClient): number {
  const next = (store.get(queryClient) ?? 0) + 1
  store.set(queryClient, next)
  return next
}

function nextProjectRefreshGenerations(queryClient: QueryClient, projectIds: string[]): Map<string, number> {
  const generations = sessionRefreshGenerations.get(queryClient) ?? new Map<string, number>()
  sessionRefreshGenerations.set(queryClient, generations)
  return new Map(
    projectIds.map((projectId) => {
      const next = (generations.get(projectId) ?? 0) + 1
      generations.set(projectId, next)
      return [projectId, next]
    }),
  )
}

function stableProjectIds(projectIds: Iterable<string | null | undefined>): string[] {
  return [...new Set([...projectIds].filter((projectId): projectId is string => Boolean(projectId)))].sort()
}

export async function refreshProjectsWindow(queryClient: QueryClient): Promise<RefreshOutcome> {
  const generation = nextRefreshGeneration(projectRefreshGenerations, queryClient)
  const current = queryClient.getQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects)
  const loadedCount = current?.pages.reduce((sum, page) => sum + page.projects.length, 0) ?? 20
  const latest = await fetchProjects(null, Math.max(1, loadedCount))
  if (projectRefreshGenerations.get(queryClient) !== generation) return 'skipped'
  const nextCurrent = queryClient.getQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects)
  const nextLoadedCount = nextCurrent?.pages.reduce((sum, page) => sum + page.projects.length, 0) ?? loadedCount
  if (nextLoadedCount > loadedCount) return 'skipped'
  queryClient.setQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects, {
    pages: [latest],
    pageParams: [null],
  })
  return 'applied'
}

function visibleProjectLoadedCount(queryClient: QueryClient, projectId: string): number {
  const detailQueries = queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-detail', projectId] })
  const detailLoaded = detailQueries.reduce((max, [queryKey, current]) => Math.max(max, typeof queryKey[2] === 'number' ? queryKey[2] : (current?.sessions.length ?? 0)), 0)
  const railWindowLoaded = queryClient
    .getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-rail-window', projectId] })
    .reduce((max, [queryKey, current]) => Math.max(max, typeof queryKey[2] === 'number' ? queryKey[2] : (current?.sessions.length ?? 0)), 0)
  return Math.max(detailLoaded, railWindowLoaded)
}

function collectVisibleProjectRequests(
  queryClient: QueryClient,
  visibleProjectIds: string[],
  selectedProjectId: string | null,
  selectedSessionId: string | null,
  selectedSessionProjectIds: ReadonlySet<string>,
): Array<{ projectId: string; limit: number; selectedSessionId?: string }> {
  return visibleProjectIds
    .map((projectId) => {
      const limit = visibleProjectLoadedCount(queryClient, projectId)
      return {
        projectId,
        limit: limit > 0 ? limit : 10,
        ...((projectId === selectedProjectId || selectedSessionProjectIds.has(projectId)) && selectedSessionId ? { selectedSessionId } : {}),
      }
    })
    .filter((entry) => entry.limit > 0)
}

function projectWindow(response: ProjectSessionsQueryResponse, projectId: string): ProjectSessionsWindow | undefined {
  return response.sessionsByProject[projectId]
}

function windowSessions(window: ProjectSessionsWindow, projectId: string, limit: number): SessionSummary[] {
  const sessions = window.sessions.slice(0, limit)
  const selectedSession = window.selectedSessionDetail
  return selectedSession?.projectId === projectId && !sessions.some((session) => session.id === selectedSession.id) ? [...sessions, selectedSession] : sessions
}

function patchProjectDetailQueries(queryClient: QueryClient, response: ProjectSessionsQueryResponse, projectId: string): void {
  const queries = queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-detail', projectId] })
  for (const [queryKey, current] of queries) {
    if (!current) continue
    const latest = projectWindow(response, projectId)
    if (!latest) continue
    const defaultSessionId = current.defaultSessionId && latest.sessions.some((session) => session.id === current.defaultSessionId) ? current.defaultSessionId : (latest.sessions[0]?.id ?? null)
    const limit = typeof queryKey[2] === 'number' ? queryKey[2] : latest.sessions.length
    queryClient.setQueryData(queryKey, {
      ...current,
      ...(latest.project ? { project: latest.project } : {}),
      sessions: windowSessions(latest, projectId, limit),
      ...(latest.selectedSessionDetail !== undefined ? { selectedSessionDetail: latest.selectedSessionDetail } : {}),
      defaultSessionId,
      hasMore: latest.hasMore || latest.sessions.length > limit,
      nextCursor: latest.nextCursor,
    })
  }
}

function patchProjectRailWindowQueries(queryClient: QueryClient, response: ProjectSessionsQueryResponse, projectId: string): void {
  const latest = projectWindow(response, projectId)
  if (!latest) return
  for (const [windowKey, currentWindow] of queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-rail-window', projectId] })) {
    if (!currentWindow) continue
    const currentDefaultSessionId = currentWindow.defaultSessionId
    const defaultSessionId = currentDefaultSessionId && latest.sessions.some((session) => session.id === currentDefaultSessionId) ? currentDefaultSessionId : (latest.sessions[0]?.id ?? null)
    const limit = typeof windowKey[2] === 'number' ? windowKey[2] : latest.sessions.length
    queryClient.setQueryData(windowKey, {
      ...currentWindow,
      ...(latest.project ? { project: latest.project } : {}),
      sessions: windowSessions(latest, projectId, limit),
      ...(latest.selectedSessionDetail !== undefined ? { selectedSessionDetail: latest.selectedSessionDetail } : {}),
      defaultSessionId,
      hasMore: latest.hasMore || latest.sessions.length > limit,
      nextCursor: latest.nextCursor,
    })
  }
}

function withoutSession(page: ProjectSessionsResponse, sessionId: string): ProjectSessionsResponse {
  const sessions = page.sessions.filter((session) => session.id !== sessionId)
  return {
    ...page,
    sessions,
    defaultSessionId: page.defaultSessionId === sessionId ? (sessions[0]?.id ?? null) : page.defaultSessionId,
  }
}

export function markSessionSearchCacheStale(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['session-search'], refetchType: 'none' })
}

export function removeSessionFromSearchCache(queryClient: QueryClient, sessionId: string): void {
  for (const [queryKey, current] of queryClient.getQueriesData<InfiniteData<ProjectSessionSearchResponse, string | null>>({ queryKey: ['session-search'] })) {
    if (!current) continue
    const removed = current.pages.flatMap((page) => page.results).find((result) => result.session.id === sessionId)
    if (!removed) continue
    queryClient.setQueryData(queryKey, {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        results: page.results.filter((result) => result.session.id !== sessionId),
        totalSessions: Math.max(0, page.totalSessions - 1),
        totalMatches: Math.max(0, page.totalMatches - removed.messageMatchCount),
      })),
    })
  }
  markSessionSearchCacheStale(queryClient)
}

export async function resetSessionSearchCache(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ['session-search'] })
  await queryClient.resetQueries({ queryKey: ['session-search'] })
}

export function removeProjectSessionFromCache(queryClient: QueryClient, projectId: string, sessionId: string): void {
  for (const [queryKey, current] of queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-detail', projectId] })) {
    if (current) queryClient.setQueryData(queryKey, withoutSession(current, sessionId))
  }

  for (const [queryKey, current] of queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-rail-window', projectId] })) {
    if (current) queryClient.setQueryData(queryKey, withoutSession(current, sessionId))
  }
}

export async function refreshVisibleProjectSessions(
  queryClient: QueryClient,
  input: { selectedProjectId: string | null; selectedSessionId?: string | null; selectedSessionProjectIds?: string[]; visibleProjectIds?: string[] },
): Promise<Map<string, ProjectRefreshResult>> {
  const selectedSessionProjectIds = new Set(input.selectedSessionProjectIds ?? [])
  const visibleProjectIds = stableProjectIds([...(input.visibleProjectIds ?? []), input.selectedProjectId, ...selectedSessionProjectIds])
  if (visibleProjectIds.length === 0) return new Map()
  const requests = collectVisibleProjectRequests(queryClient, visibleProjectIds, input.selectedProjectId, input.selectedSessionId ?? null, selectedSessionProjectIds)
  if (requests.length === 0) return new Map()
  const generations = nextProjectRefreshGenerations(
    queryClient,
    requests.map(({ projectId }) => projectId),
  )
  const response = await queryProjectSessions(requests)
  const currentGenerations = sessionRefreshGenerations.get(queryClient)
  const outcomes = new Map<string, ProjectRefreshResult>()
  for (const { projectId, limit } of requests) {
    if (currentGenerations?.get(projectId) !== generations.get(projectId)) {
      outcomes.set(projectId, { outcome: 'skipped' })
      continue
    }
    const latest = projectWindow(response, projectId)
    if (!latest) {
      outcomes.set(projectId, { outcome: 'missing' })
      continue
    }
    if (visibleProjectLoadedCount(queryClient, projectId) > limit) {
      outcomes.set(projectId, {
        outcome: 'skipped',
        ...(latest.selectedSessionExists !== undefined ? { selectedSessionExists: latest.selectedSessionExists } : {}),
        ...(latest.selectedSessionDetail !== undefined ? { selectedSessionDetail: latest.selectedSessionDetail } : {}),
      })
      continue
    }
    patchProjectDetailQueries(queryClient, response, projectId)
    patchProjectRailWindowQueries(queryClient, response, projectId)
    outcomes.set(projectId, {
      outcome: 'applied',
      ...(latest.selectedSessionExists !== undefined ? { selectedSessionExists: latest.selectedSessionExists } : {}),
      ...(latest.selectedSessionDetail !== undefined ? { selectedSessionDetail: latest.selectedSessionDetail } : {}),
    })
  }
  return outcomes
}

export async function refreshProjectSessionLists(
  queryClient: QueryClient,
  input: { selectedProjectId: string | null; selectedSessionId?: string | null; selectedSessionProjectIds?: string[]; visibleProjectIds?: string[] },
): Promise<{ projects: RefreshOutcome; sessions: Map<string, ProjectRefreshResult> }> {
  const projects = await refreshProjectsWindow(queryClient)
  const sessions = await refreshVisibleProjectSessions(queryClient, input)
  return { projects, sessions }
}
