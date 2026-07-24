import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { ProjectSessionsQueryResponse, ProjectSessionsResponse, ProjectsResponse, SessionSummary } from '@cotta/shared'
import { fetchProjects, queryProjectSessions } from './api'

export const sessionQueryKeys = {
  projects: ['projects'] as const,
  projectSessionsDetail: (projectId: string | null, sessionLimit: number) => ['project-sessions-detail', projectId, sessionLimit] as const,
  projectSessionsRail: (projectId: string) => ['project-sessions-rail', projectId] as const,
}

const projectRefreshGenerations = new WeakMap<QueryClient, number>()
const sessionRefreshGenerations = new WeakMap<QueryClient, Map<string, number>>()

export type RefreshOutcome = 'applied' | 'skipped' | 'missing'

export type ProjectRefreshResult = {
  outcome: RefreshOutcome
  selectedSessionExists?: boolean
}

function nextRefreshGeneration(store: WeakMap<QueryClient, number>, queryClient: QueryClient): number {
  const next = (store.get(queryClient) ?? 0) + 1
  store.set(queryClient, next)
  return next
}

function nextProjectRefreshGenerations(queryClient: QueryClient, projectIds: string[]): Map<string, number> {
  const generations = sessionRefreshGenerations.get(queryClient) ?? new Map<string, number>()
  sessionRefreshGenerations.set(queryClient, generations)
  return new Map(projectIds.map((projectId) => {
    const next = (generations.get(projectId) ?? 0) + 1
    generations.set(projectId, next)
    return [projectId, next]
  }))
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
  const detailLoaded = detailQueries.reduce((max, [queryKey, current]) => Math.max(max, typeof queryKey[2] === 'number' ? queryKey[2] : current?.sessions.length ?? 0), 0)
  const railQuery = queryClient.getQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(sessionQueryKeys.projectSessionsRail(projectId))
  const railLoaded = railQuery?.pages.reduce((sum, page) => sum + page.sessions.length, 0) ?? 0
  return Math.max(detailLoaded, railLoaded)
}

function collectVisibleProjectRequests(queryClient: QueryClient, visibleProjectIds: string[], selectedProjectId: string | null, selectedSessionId: string | null): Array<{ projectId: string; limit: number; selectedSessionId?: string }> {
  return visibleProjectIds.map((projectId) => {
    const limit = visibleProjectLoadedCount(queryClient, projectId)
    return {
      projectId,
      limit: limit > 0 ? limit : 10,
      ...(projectId === selectedProjectId && selectedSessionId ? { selectedSessionId } : {}),
    }
  }).filter((entry) => entry.limit > 0)
}

function projectWindow(response: ProjectSessionsQueryResponse, projectId: string) {
  return response.sessionsByProject[projectId]
}

function patchProjectDetailQueries(queryClient: QueryClient, response: ProjectSessionsQueryResponse, projectId: string): void {
  const queries = queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-detail', projectId] })
  for (const [queryKey, current] of queries) {
    if (!current) continue
    const latest = projectWindow(response, projectId)
    if (!latest) continue
    queryClient.setQueryData(queryKey, {
      ...current,
      sessions: latest.sessions,
      hasMore: latest.hasMore,
      nextCursor: latest.nextCursor,
    })
  }
}

function projectForRail(queryClient: QueryClient, projectId: string) {
  const projects = queryClient.getQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects)
  return projects?.pages.flatMap((page) => page.projects).find((project) => project.id === projectId) ?? { id: projectId, name: projectId }
}

function patchProjectRailQuery(queryClient: QueryClient, response: ProjectSessionsQueryResponse, projectId: string): void {
  const queryKey = sessionQueryKeys.projectSessionsRail(projectId)
  const current = queryClient.getQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(queryKey)
  const latest = projectWindow(response, projectId)
  if (!latest) return
  const project = current?.pages[0]?.project ?? projectForRail(queryClient, projectId)
  const defaultSessionId = current?.pages[0]?.defaultSessionId ?? latest.sessions[0]?.id ?? null
  queryClient.setQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(queryKey, {
    pages: [{
      project,
      sessions: latest.sessions,
      defaultSessionId,
      hasMore: latest.hasMore,
      nextCursor: latest.nextCursor,
    }],
    pageParams: [null],
  })
}

export async function refreshVisibleProjectSessions(
  queryClient: QueryClient,
  input: { selectedProjectId: string | null; selectedSessionId?: string | null; visibleProjectIds?: string[] },
): Promise<Map<string, ProjectRefreshResult>> {
  const visibleProjectIds = stableProjectIds(input.visibleProjectIds ?? [input.selectedProjectId])
  if (visibleProjectIds.length === 0) return new Map()
  const requests = collectVisibleProjectRequests(queryClient, visibleProjectIds, input.selectedProjectId, input.selectedSessionId ?? null)
  if (requests.length === 0) return new Map()
  const generations = nextProjectRefreshGenerations(queryClient, requests.map(({ projectId }) => projectId))
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
      outcomes.set(projectId, { outcome: 'skipped' })
      continue
    }
    patchProjectDetailQueries(queryClient, response, projectId)
    patchProjectRailQuery(queryClient, response, projectId)
    outcomes.set(projectId, { outcome: 'applied', selectedSessionExists: latest.selectedSessionExists })
  }
  return outcomes
}

export async function refreshProjectSessionLists(
  queryClient: QueryClient,
  input: { selectedProjectId: string | null; selectedSessionId?: string | null; visibleProjectIds?: string[] },
): Promise<{ projects: RefreshOutcome; sessions: Map<string, ProjectRefreshResult> }> {
  const projects = await refreshProjectsWindow(queryClient)
  const sessions = await refreshVisibleProjectSessions(queryClient, input)
  return { projects, sessions }
}
