import {
  authSessionResponseSchema,
  createProjectResponseSchema,
  deleteSessionResponseSchema,
  forkSessionResponseSchema,
  githubDevicePollResponseSchema,
  githubDeviceStartResponseSchema,
  listVersionsEventSchema,
  logoutResponseSchema,
  modelCatalogResponseSchema,
  projectDirectoriesResponseSchema,
  projectSessionsQueryResponseSchema,
  renameSessionResponseSchema,
  settingsResponseSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  sessionInfoResponseSchema,
  sessionLiveEventsResponseSchema,
  sessionObservationsResponseSchema,
  sessionRawMessagesResponseSchema,
  sessionRuntimeResponseSchema,
  sessionTimelineResponseSchema,
  sessionTimelineStateResponseSchema,
  type AuthSessionResponse,
  type CreateProjectResponse,
  type DeleteSessionResponse,
  type ForkSessionResponse,
  type GitHubDevicePollResponse,
  type GitHubDeviceStartResponse,
  type ListVersionsEvent,
  type LogoutResponse,
  type ModelCatalogResponse,
  type ProjectDirectoriesResponse,
  type ProjectSessionsQueryResponse,
  type ProjectSessionsResponse,
  type ProjectsResponse,
  type RenameSessionResponse,
  type SettingsResponse,
  type SessionInfoResponse,
  type SessionLiveEventsResponse,
  type SessionObservationsResponse,
  type SessionObservationSort,
  type SessionRawMessagesResponse,
  type SessionRuntimeResponse,
  type SessionTimelineResponse,
  type SessionTimelineStateResponse,
} from '@cotta/shared'

export class PaginationCursorStaleError extends Error {}

async function throwRequestError(response: Response, label: string): Promise<never> {
  if (response.status === 409 && (await response.json() as { error?: string }).error === 'pagination_cursor_stale') {
    throw new PaginationCursorStaleError(`${label} cursor is stale`)
  }
  throw new Error(`${label} request failed: ${response.status}`)
}

export class CreateProjectHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`Create project failed: ${code ?? status}`)
  }
}

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  const response = await fetch('/api/auth/session')
  if (!response.ok) throw new Error(`Auth session request failed: ${response.status}`)
  return authSessionResponseSchema.parse(await response.json())
}

export async function startGitHubDeviceLogin(): Promise<GitHubDeviceStartResponse> {
  const response = await fetch('/api/auth/github/device/start', { method: 'POST' })
  if (!response.ok) throw new Error(`GitHub login start failed: ${response.status}`)
  return githubDeviceStartResponseSchema.parse(await response.json())
}

export async function pollGitHubDeviceLogin(flowId: string): Promise<GitHubDevicePollResponse> {
  const response = await fetch('/api/auth/github/device/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flowId }),
  })
  if (response.status !== 202 && !response.ok) throw new Error(`GitHub login poll failed: ${response.status}`)
  return githubDevicePollResponseSchema.parse(await response.json())
}

export async function logout(): Promise<LogoutResponse> {
  const response = await fetch('/api/auth/logout', { method: 'POST' })
  if (!response.ok) throw new Error(`Logout failed: ${response.status}`)
  return logoutResponseSchema.parse(await response.json())
}

export async function createProject(directoryPath: string): Promise<CreateProjectResponse> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directoryPath }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new CreateProjectHttpError(response.status, body?.error ?? null)
  }
  return createProjectResponseSchema.parse(await response.json())
}

export async function fetchProjectDirectories(parent = ''): Promise<ProjectDirectoriesResponse> {
  const params = new URLSearchParams({ parent })
  const response = await fetch(`/api/project-directories?${params}`)
  if (!response.ok) throw new Error(`Project directories request failed: ${response.status}`)
  return projectDirectoriesResponseSchema.parse(await response.json())
}

export async function fetchProjects(cursor: string | null = null, limit = 20): Promise<ProjectsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/projects?${params}`)
  if (!response.ok) await throwRequestError(response, 'Projects')
  return projectsResponseSchema.parse(await response.json())
}

export async function fetchProjectSessions(
  projectId: string,
  cursor: string | null = null,
  limit = 10,
): Promise<ProjectSessionsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params}`)
  if (!response.ok) await throwRequestError(response, 'Project sessions')
  return projectSessionsResponseSchema.parse(await response.json())
}

export async function queryProjectSessions(projects: Array<{ projectId: string; limit: number; selectedSessionId?: string }>): Promise<ProjectSessionsQueryResponse> {
  const response = await fetch('/api/project-sessions/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects }),
  })
  if (!response.ok) throw new Error(`Project sessions query failed: ${response.status}`)
  return projectSessionsQueryResponseSchema.parse(await response.json())
}

export async function fetchModelCatalog(projectId: string | null): Promise<ModelCatalogResponse> {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const response = await fetch(`/api/model-catalog${params}`)
  if (!response.ok) throw new Error(`Model catalog request failed: ${response.status}`)
  return modelCatalogResponseSchema.parse(await response.json())
}

export async function fetchSessionObservations(input: { sessionId?: string | null; sort: SessionObservationSort; direction: 'asc' | 'desc'; limit: number; offset: number }): Promise<SessionObservationsResponse> {
  const params = new URLSearchParams({ sort: input.sort, direction: input.direction, limit: String(input.limit), offset: String(input.offset) })
  if (input.sessionId !== undefined) params.set('sessionId', input.sessionId ?? '')
  const response = await fetch(`/api/debug/session-observations?${params}`)
  if (!response.ok) throw new Error(`Session observations request failed: ${response.status}`)
  return sessionObservationsResponseSchema.parse(await response.json())
}

export async function fetchSettings(): Promise<SettingsResponse> {
  const response = await fetch('/api/settings')
  if (!response.ok) throw new Error(`Settings request failed: ${response.status}`)
  return settingsResponseSchema.parse(await response.json())
}

export async function saveSettings(settings: SettingsResponse['settings']): Promise<SettingsResponse> {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  if (!response.ok) throw new Error(`Settings save failed: ${response.status}`)
  return settingsResponseSchema.parse(await response.json())
}

export async function refreshModelCatalog(projectId: string | null): Promise<SettingsResponse> {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  const response = await fetch(`/api/settings/model-catalog/refresh${params}`, { method: 'POST' })
  if (!response.ok) throw new Error(`Model catalog refresh failed: ${response.status}`)
  return settingsResponseSchema.parse(await response.json())
}

export async function fetchSessionTimeline(
  projectId: string,
  sessionId: string,
  cursor: string | null = null,
): Promise<SessionTimelineResponse> {
  const params = new URLSearchParams({ limitTurns: '20' })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`,
  )
  if (!response.ok) throw new Error(`Session timeline request failed: ${response.status}`)
  return sessionTimelineResponseSchema.parse(await response.json())
}

export async function fetchSessionRawMessages(
  projectId: string,
  sessionId: string,
  turnId?: string,
): Promise<SessionRawMessagesResponse> {
  const params = turnId ? `?turnId=${encodeURIComponent(turnId)}` : ''
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/raw-messages${params}`,
  )
  if (!response.ok) throw new Error(`Session raw messages request failed: ${response.status}`)
  return sessionRawMessagesResponseSchema.parse(await response.json())
}

export async function fetchSessionLiveEvents(
  projectId: string,
  sessionId: string,
  limit = 500,
): Promise<SessionLiveEventsResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/live-sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`,
  )
  if (!response.ok) throw new Error(`Session live events request failed: ${response.status}`)
  return sessionLiveEventsResponseSchema.parse(await response.json())
}

export async function deleteSession(projectId: string, sessionId: string, confirmationSessionId: string): Promise<DeleteSessionResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/delete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationSessionId }),
    },
  )
  if (!response.ok) throw new Error(`Session delete request failed: ${response.status}`)
  return deleteSessionResponseSchema.parse(await response.json())
}

export async function renameSession(projectId: string, sessionId: string, title: string): Promise<RenameSessionResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/rename`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    },
  )
  if (!response.ok) throw new Error(`Session rename request failed: ${response.status}`)
  return renameSessionResponseSchema.parse(await response.json())
}

export async function forkSession(projectId: string, sessionId: string, upToMessageId?: string): Promise<ForkSessionResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upToMessageId ? { upToMessageId } : {}),
    },
  )
  if (!response.ok) throw new Error(`Session fork request failed: ${response.status}`)
  return forkSessionResponseSchema.parse(await response.json())
}

export async function fetchSessionInfo(projectId: string, sessionId: string): Promise<SessionInfoResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/info`,
  )
  if (!response.ok) throw new Error(`Session info request failed: ${response.status}`)
  return sessionInfoResponseSchema.parse(await response.json())
}

export async function fetchSessionTimelineState(
  projectId: string,
  sessionId: string,
): Promise<SessionTimelineStateResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/timeline/state`,
  )
  if (!response.ok) throw new Error(`Session timeline state request failed: ${response.status}`)
  return sessionTimelineStateResponseSchema.parse(await response.json())
}

export async function refreshProjects(_projectId: string | null = null): Promise<void> {
  const response = await fetch('/api/projects/refresh', { method: 'POST' })
  if (!response.ok) throw new Error(`Projects refresh request failed: ${response.status}`)
}

export function connectListVersions(onEvent: (event: ListVersionsEvent) => void): EventSource {
  const events = new EventSource('/api/list-versions/events')
  events.onmessage = (message) => {
    onEvent(listVersionsEventSchema.parse(JSON.parse(message.data)))
  }
  return events
}

export async function ensureSessionRuntime(projectId: string, sessionId: string): Promise<SessionRuntimeResponse> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/runtime`,
    { method: 'POST' },
  )
  if (!response.ok) throw new Error(`Session runtime request failed: ${response.status}`)
  return sessionRuntimeResponseSchema.parse(await response.json())
}
