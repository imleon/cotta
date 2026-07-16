import {
  projectSessionsResponseSchema,
  projectsResponseSchema,
  sessionTimelineResponseSchema,
  sessionTimelineStateResponseSchema,
  type ProjectSessionsResponse,
  type ProjectsResponse,
  type SessionTimelineResponse,
  type SessionTimelineStateResponse,
} from '@cotta/shared'

export function authToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
}

export function withToken(path: string): string {
  const token = authToken()
  if (!token) return path
  const url = new URL(path, window.location.origin)
  url.searchParams.set('token', token)
  return `${url.pathname}${url.search}`
}

export async function fetchProjects(): Promise<ProjectsResponse> {
  const response = await fetch(withToken('/api/projects'))
  if (!response.ok) throw new Error(`Projects request failed: ${response.status}`)
  return projectsResponseSchema.parse(await response.json())
}

export async function fetchProjectSessions(
  projectId: string,
  cursor: string | null = null,
  limit = 10,
): Promise<ProjectSessionsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params}`))
  if (!response.ok) throw new Error(`Project sessions request failed: ${response.status}`)
  return projectSessionsResponseSchema.parse(await response.json())
}

export async function fetchSessionTimeline(
  projectId: string,
  sessionId: string,
  cursor: string | null = null,
): Promise<SessionTimelineResponse> {
  const params = new URLSearchParams({ limitTurns: '20' })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`),
  )
  if (!response.ok) throw new Error(`Session timeline request failed: ${response.status}`)
  return sessionTimelineResponseSchema.parse(await response.json())
}

export async function fetchSessionTimelineState(
  projectId: string,
  sessionId: string,
): Promise<SessionTimelineStateResponse> {
  const response = await fetch(
    withToken(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline/state`),
  )
  if (!response.ok) throw new Error(`Session timeline state request failed: ${response.status}`)
  return sessionTimelineStateResponseSchema.parse(await response.json())
}
