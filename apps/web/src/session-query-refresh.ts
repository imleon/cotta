import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { ProjectSessionsResponse } from '@cotta/shared'
import { fetchProjectSessions } from './api'

export const sessionQueryKeys = {
  projects: ['projects'] as const,
  projectSessionsDetail: (projectId: string | null, sessionLimit: number) => ['project-sessions-detail', projectId, sessionLimit] as const,
  projectSessionsRail: (projectId: string) => ['project-sessions-rail', projectId] as const,
}

export function refreshProjectSessionLists(queryClient: QueryClient, projectId: string): void {
  void queryClient.invalidateQueries({ queryKey: sessionQueryKeys.projects })
  void queryClient.invalidateQueries({ queryKey: ['project-sessions-detail', projectId] })
  void refreshProjectSessionsRail(queryClient, projectId).catch(() => {})
}

async function refreshProjectSessionsRail(queryClient: QueryClient, projectId: string): Promise<void> {
  const queryKey = sessionQueryKeys.projectSessionsRail(projectId)
  const firstPage = await fetchProjectSessions(projectId, null, 10)
  queryClient.setQueryData<InfiniteData<ProjectSessionsResponse, string | null>>(queryKey, (current) => ({
    pages: [firstPage],
    pageParams: [null],
    ...(!current ? {} : {
      pages: [firstPage, ...current.pages.slice(1).filter((page) => !page.sessions.some((session) => firstPage.sessions.some((nextSession) => nextSession.id === session.id)))],
      pageParams: [null, ...current.pageParams.slice(1)],
    }),
  }))
}
