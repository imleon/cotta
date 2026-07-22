import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { ProjectSessionsQueryResponse, ProjectSessionsResponse, ProjectsResponse, SessionSummary } from '@cotta/shared'
import { fetchProjects, queryProjectSessions } from './api'

export const sessionQueryKeys = {
  projects: ['projects'] as const,
  projectSessionsDetail: (projectId: string | null, sessionLimit: number) => ['project-sessions-detail', projectId, sessionLimit] as const,
  projectSessionsRail: (projectId: string) => ['project-sessions-rail', projectId] as const,
}

const projectRefreshGenerations = new WeakMap<QueryClient, number>()
const sessionRefreshGenerations = new WeakMap<QueryClient, number>()

function nextRefreshGeneration(store: WeakMap<QueryClient, number>, queryClient: QueryClient): number {
  const next = (store.get(queryClient) ?? 0) + 1
  store.set(queryClient, next)
  return next
}

function stableProjectIds(projectIds: Iterable<string | null | undefined>): string[] {
  return [...new Set([...projectIds].filter((projectId): projectId is string => Boolean(projectId)))].sort()
}

function repageSessions(sessions: SessionSummary[], templatePages: number[], fallbackPageSize: number): SessionSummary[][] {
  if (templatePages.length === 0) return [sessions.slice(0, fallbackPageSize)]
  const pages: SessionSummary[][] = []
  let offset = 0
  for (const size of templatePages) {
    const next = sessions.slice(offset, offset + size)
    if (next.length === 0) break
    pages.push(next)
    offset += size
  }
  if (pages.length === 0) pages.push(sessions.slice(0, fallbackPageSize))
  return pages
}

export async function refreshProjectsWindow(queryClient: QueryClient): Promise<void> {
  const generation = nextRefreshGeneration(projectRefreshGenerations, queryClient)
  const current = queryClient.getQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects)
  const loadedCount = current?.pages.reduce((sum, page) => sum + page.projects.length, 0) ?? 20
  const pageSizes = current?.pages.map((page) => page.projects.length).filter((size) => size > 0) ?? [20]
  const latest = await fetchProjects(null, Math.max(1, loadedCount))
  if (projectRefreshGenerations.get(queryClient) !== generation) return
  const nextCurrent = queryClient.getQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects)
  const nextLoadedCount = nextCurrent?.pages.reduce((sum, page) => sum + page.projects.length, 0) ?? loadedCount
  if (nextLoadedCount > loadedCount) return
  const pages = [] as ProjectsResponse[]
  let offset = 0
  for (const size of pageSizes) {
    const projects = latest.projects.slice(offset, offset + size)
    if (projects.length === 0) break
    pages.push({
      projects,
      hasMore: offset + size < latest.projects.length ? true : latest.hasMore,
      nextCursor: offset + size < latest.projects.length ? projects.at(-1)?.id ?? null : latest.nextCursor,
    })
    offset += size
  }
  if (pages.length === 0) pages.push(latest)
  queryClient.setQueryData<InfiniteData<ProjectsResponse, string | null>>(sessionQueryKeys.projects, {
    pages,
    pageParams: pages.map((_, index) => index === 0 ? null : pages[index - 1]?.nextCursor ?? null),
  })
}

function visibleProjectLoadedCount(queryClient: QueryClient, projectId: string): number {
  const detailQueries = queryClient.getQueriesData<ProjectSessionsResponse>({ queryKey: ['project-sessions-detail', projectId] })
  const detailLoaded = detailQueries.reduce((max, [queryKey, current]) => Math.max(max, typeof queryKey[2] === 'number' ? queryKey[2] : current?.sessions.length ?? 0), 0)
  const railQuery = queryClient.getQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(sessionQueryKeys.projectSessionsRail(projectId))
  const railLoaded = railQuery?.pages.reduce((sum, page) => sum + page.sessions.length, 0) ?? 0
  return Math.max(detailLoaded, railLoaded)
}

function collectVisibleProjectRequests(queryClient: QueryClient, visibleProjectIds: string[]): Array<{ projectId: string; limit: number }> {
  return visibleProjectIds.map((projectId) => {
    const limit = visibleProjectLoadedCount(queryClient, projectId)
    return { projectId, limit: limit > 0 ? limit : 10 }
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
  const pageSizes = current?.pages.map((page) => page.sessions.length).filter((size) => size > 0) ?? [Math.min(10, latest.sessions.length || 10)]
  const repaged = repageSessions(latest.sessions, pageSizes, 10)
  const project = current?.pages[0]?.project ?? projectForRail(queryClient, projectId)
  const defaultSessionId = current?.pages[0]?.defaultSessionId ?? latest.sessions[0]?.id ?? null
  const pages = repaged.map((sessions, index) => ({
    project: current?.pages[index]?.project ?? project,
    sessions,
    defaultSessionId: current?.pages[index]?.defaultSessionId ?? defaultSessionId,
    hasMore: index < repaged.length - 1 ? true : latest.hasMore,
    nextCursor: index < repaged.length - 1 ? sessions.at(-1)?.id ?? null : latest.nextCursor,
  }))
  queryClient.setQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(queryKey, {
    pages,
    pageParams: pages.map((_, index) => index === 0 ? null : pages[index - 1]?.nextCursor ?? null),
  })
}

export async function refreshVisibleProjectSessions(
  queryClient: QueryClient,
  input: { selectedProjectId: string | null; visibleProjectIds?: string[] },
): Promise<void> {
  const generation = nextRefreshGeneration(sessionRefreshGenerations, queryClient)
  const visibleProjectIds = stableProjectIds(input.visibleProjectIds ?? [input.selectedProjectId])
  if (visibleProjectIds.length === 0) return
  const requests = collectVisibleProjectRequests(queryClient, visibleProjectIds)
  if (requests.length === 0) return
  const response = await queryProjectSessions(requests)
  if (sessionRefreshGenerations.get(queryClient) !== generation) return
  for (const { projectId, limit } of requests) {
    if (visibleProjectLoadedCount(queryClient, projectId) > limit) continue
    patchProjectDetailQueries(queryClient, response, projectId)
    patchProjectRailQuery(queryClient, response, projectId)
  }
}

export async function refreshProjectSessionLists(
  queryClient: QueryClient,
  input: { selectedProjectId: string | null; visibleProjectIds?: string[] },
): Promise<void> {
  await refreshProjectsWindow(queryClient)
  await refreshVisibleProjectSessions(queryClient, input)
}
