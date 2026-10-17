import {
  type AppSettingsUpdate,
  type AskUserQuestionDecisionRequest,
  type AuthSessionResponse,
  askUserQuestionDecisionRequestSchema,
  authSessionResponseSchema,
  type BuildInfoResponse,
  buildInfoResponseSchema,
  type CreateRemoteBotRequest,
  type CreateShareResponse,
  createShareResponseSchema,
  type DeleteSessionResponse,
  type DetailResponse,
  deleteSessionResponseSchema,
  detailResponseSchema,
  type ForkSessionResponse,
  forkSessionResponseSchema,
  type GitHubConfig,
  type GitHubDevicePollResponse,
  type GitHubDeviceStartResponse,
  githubConfigSchema,
  githubDevicePollResponseSchema,
  githubDeviceStartResponseSchema,
  type ListVersionsEvent,
  type LogoutResponse,
  listVersionsEventSchema,
  logoutResponseSchema,
  type ProjectFileDiffResponse,
  type ProjectFileResponse,
  type ProjectFilesGitResponse,
  type ProjectFilesResponse,
  type ProjectSessionSearchResponse,
  type ProjectSessionsQueryResponse,
  type ProjectSessionsResponse,
  type ProjectsResponse,
  projectFileDiffResponseSchema,
  projectFileResponseSchema,
  projectFilesGitResponseSchema,
  projectFilesResponseSchema,
  projectSessionSearchResponseSchema,
  projectSessionsQueryResponseSchema,
  projectSessionsResponseSchema,
  projectsResponseSchema,
  type RemoteBotMutationResponse,
  type RemoteBotResolveResponse,
  type RemoteBotResponse,
  type RemoteBotsResponse,
  type RenameSessionResponse,
  type RestartSessionRuntimeResponse,
  remoteBotMutationResponseSchema,
  remoteBotResolveResponseSchema,
  remoteBotResponseSchema,
  remoteBotsResponseSchema,
  renameSessionResponseSchema,
  restartSessionRuntimeResponseSchema,
  type SessionPinsResponse,
  type SessionPinUpdateResponse,
  type SessionProjectResponse,
  type SessionRawMessagesResponse,
  type SessionRuntimeResponse,
  type SessionTimelineControlResponse,
  type SessionTimelineResponse,
  type SettingsResponse,
  type ShareListResponse,
  sessionPinsResponseSchema,
  sessionPinUpdateResponseSchema,
  sessionProjectResponseSchema,
  sessionRawMessagesResponseSchema,
  sessionRuntimeResponseSchema,
  sessionTimelineControlResponseSchema,
  sessionTimelineResponseSchema,
  settingsResponseSchema,
  shareListResponseSchema,
  type TokenUsageDailyResponse,
  type TokenUsageRange,
  type TokenUsageResponse,
  type ToolApprovalDecisionRequest,
  type ToolApprovalDecisionResponse,
  type TurnOptionsUpdateRequest,
  type TurnSubagentsTreeResponse,
  type TurnSubagentTranscriptResponse,
  tokenUsageDailyResponseSchema,
  tokenUsageResponseSchema,
  toolApprovalDecisionRequestSchema,
  toolApprovalDecisionResponseSchema,
  turnOptionsUpdateRequestSchema,
  turnSubagentsTreeResponseSchema,
  turnSubagentTranscriptResponseSchema,
  type UpdateRemoteBotRequest,
} from '@cotta/shared'

export class PaginationCursorStaleError extends Error {}
export class TimelineSnapshotStaleError extends Error {}

export type LocalImageConfirmation = { canonicalPath: string; dev: string; ino: string; size: number }

export class LocalImageHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly size?: number,
    readonly external?: boolean,
    readonly resolvedPath?: string,
    readonly confirmation?: LocalImageConfirmation,
  ) {
    super(`Local image request failed: ${code ?? status}`)
  }
}

export async function fetchBuildInfo(): Promise<BuildInfoResponse> {
  const response = await fetch('/api/build-info')
  if (!response.ok) throw new Error(`Build info request failed: ${response.status}`)
  return buildInfoResponseSchema.parse(await response.json())
}

export async function fetchUsage(range: TokenUsageRange, timeZone: string): Promise<TokenUsageResponse> {
  const params = new URLSearchParams({ range, timeZone })
  const response = await fetch(`/api/token-usage?${params}`)
  if (!response.ok) throw new Error(`Usage request failed: ${response.status}`)
  return tokenUsageResponseSchema.parse(await response.json())
}

export async function fetchDailyUsage(days: number, timeZone: string): Promise<TokenUsageDailyResponse> {
  const params = new URLSearchParams({ days: String(days), timeZone })
  const response = await fetch(`/api/token-usage/daily?${params}`)
  if (!response.ok) throw new Error(`Daily usage request failed: ${response.status}`)
  return tokenUsageDailyResponseSchema.parse(await response.json())
}

export async function refreshUsage(): Promise<void> {
  const response = await fetch('/api/token-usage/refresh', { method: 'POST' })
  if (!response.ok) throw new Error(`Usage refresh failed: ${response.status}`)
}

async function throwRequestError(response: Response, label: string): Promise<never> {
  if (response.status === 409 && ((await response.json()) as { error?: string }).error === 'pagination_cursor_stale') {
    throw new PaginationCursorStaleError(`${label} cursor is stale`)
  }
  throw new Error(`${label} request failed: ${response.status}`)
}

export class ProjectFileHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Project file request failed: ${code ?? status}`)
  }
}

export class SessionRuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Session runtime request failed: ${code ?? status}`)
  }
}

async function throwProjectFileError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new ProjectFileHttpError(response.status, body?.error ?? null)
}

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  const response = await fetch('/api/auth/session')
  if (!response.ok) throw new Error(`Auth session request failed: ${response.status}`)
  return authSessionResponseSchema.parse(await response.json())
}

export class DetailUnavailableError extends Error {}

export async function fetchDetail(token: string): Promise<DetailResponse> {
  const response = await fetch(`/api/detail/${encodeURIComponent(token)}`, { cache: 'no-store' })
  if (!response.ok) throw new DetailUnavailableError(`Detail unavailable: ${response.status}`)
  return detailResponseSchema.parse(await response.json())
}

export class ShareUnavailableError extends Error {}

export async function fetchShare(token: string): Promise<DetailResponse> {
  const response = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: 'no-store' })
  if (!response.ok) throw new ShareUnavailableError(`Share unavailable: ${response.status}`)
  return detailResponseSchema.parse(await response.json())
}

export async function createShare(body: { detailToken: string } | { projectId: string; sessionId: string; turnId: string }): Promise<CreateShareResponse> {
  const response = await fetch('/api/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body) })
  if (!response.ok) await throwRequestError(response, 'Share creation')
  return createShareResponseSchema.parse(await response.json())
}

export async function listShares(cursor: string | null = null): Promise<ShareListResponse> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const response = await fetch(`/api/shares${params}`)
  if (!response.ok) throw new Error(`List shares failed: ${response.status}`)
  return shareListResponseSchema.parse(await response.json())
}

export async function revokeShare(token: string): Promise<void> {
  const response = await fetch(`/api/share/${encodeURIComponent(token)}/revoke`, { method: 'POST' })
  if (!response.ok) throw new Error(`Revoke failed: ${response.status}`)
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
  if (response.status !== 202 && !response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    if (body?.error === 'forbidden') throw new Error('This GitHub account is not the allowed Cotta user.')
    throw new Error(`GitHub login poll failed: ${body?.error ?? response.status}`)
  }
  return githubDevicePollResponseSchema.parse(await response.json())
}

export async function logout(): Promise<LogoutResponse> {
  const response = await fetch('/api/auth/logout', { method: 'POST' })
  if (!response.ok) throw new Error(`Logout failed: ${response.status}`)
  return logoutResponseSchema.parse(await response.json())
}

export async function fetchProjectFiles(projectId: string, path = ''): Promise<ProjectFilesResponse> {
  const params = new URLSearchParams({ path })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files?${params}`)
  if (!response.ok) await throwProjectFileError(response)
  return projectFilesResponseSchema.parse(await response.json())
}

export async function fetchProjectFile(projectId: string, path: string): Promise<ProjectFileResponse> {
  const params = new URLSearchParams({ path })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file?${params}`)
  if (!response.ok) await throwProjectFileError(response)
  return projectFileResponseSchema.parse(await response.json())
}

export async function fetchProjectFileImage(projectId: string, path: string): Promise<Blob> {
  const params = new URLSearchParams({ path })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file/image?${params}`)
  if (!response.ok) await throwProjectFileError(response)
  return response.blob()
}

export async function fetchProjectFilesGit(projectId: string): Promise<ProjectFilesGitResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/git`)
  if (!response.ok) await throwProjectFileError(response)
  return projectFilesGitResponseSchema.parse(await response.json())
}

export async function fetchProjectFileDiff(projectId: string, path: string): Promise<ProjectFileDiffResponse> {
  const params = new URLSearchParams({ path })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file/diff?${params}`)
  if (!response.ok) await throwProjectFileError(response)
  return projectFileDiffResponseSchema.parse(await response.json())
}

export async function fetchProjects(cursor: string | null = null, limit = 20): Promise<ProjectsResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/projects?${params}`)
  if (!response.ok) await throwRequestError(response, 'Projects')
  return projectsResponseSchema.parse(await response.json())
}

export async function fetchProjectSessions(projectId: string, cursor: string | null = null, limit = 10): Promise<ProjectSessionsResponse> {
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

export async function searchProjectSessions(query: string, cursor: string | null = null): Promise<ProjectSessionSearchResponse> {
  const response = await fetch('/api/project-sessions/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(cursor ? { cursor } : {}) }),
  })
  if (!response.ok) await throwRequestError(response, 'Project sessions search')
  return projectSessionSearchResponseSchema.parse(await response.json())
}

export async function fetchRemoteBots(): Promise<RemoteBotsResponse> {
  const response = await fetch('/api/remote-bots')
  if (!response.ok) throw new Error(`Remote bots request failed: ${response.status}`)
  return remoteBotsResponseSchema.parse(await response.json())
}

async function remoteBotRequest<T>(path: string, method: string, schema: { parse(value: unknown): T }, body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error(`Remote bot request failed: ${response.status}`)
  return schema.parse(await response.json())
}

export function createRemoteBot(bot: CreateRemoteBotRequest): Promise<RemoteBotResponse> {
  return remoteBotRequest('/api/remote-bots', 'POST', remoteBotResponseSchema, bot)
}

export function updateRemoteBot(botId: string, update: UpdateRemoteBotRequest): Promise<RemoteBotResponse> {
  return remoteBotRequest(`/api/remote-bots/${encodeURIComponent(botId)}`, 'PUT', remoteBotResponseSchema, update)
}

export function deleteRemoteBot(botId: string): Promise<RemoteBotMutationResponse> {
  return remoteBotRequest(`/api/remote-bots/${encodeURIComponent(botId)}`, 'DELETE', remoteBotMutationResponseSchema)
}

export function resolveRemoteBot(botId: string, chatId: string): Promise<RemoteBotResolveResponse> {
  return remoteBotRequest(`/api/remote-bots/${encodeURIComponent(botId)}/resolve`, 'POST', remoteBotResolveResponseSchema, { chatId })
}

export function bindRemoteBot(botId: string, chatId: string): Promise<RemoteBotResponse> {
  return remoteBotRequest(`/api/remote-bots/${encodeURIComponent(botId)}/bind`, 'POST', remoteBotResponseSchema, { chatId })
}

export function unpairRemoteBot(botId: string): Promise<RemoteBotMutationResponse> {
  return remoteBotRequest(`/api/remote-bots/${encodeURIComponent(botId)}/unpair`, 'POST', remoteBotMutationResponseSchema)
}

export async function fetchSettings(): Promise<SettingsResponse> {
  const response = await fetch('/api/settings')
  if (!response.ok) throw new Error(`Settings request failed: ${response.status}`)
  return settingsResponseSchema.parse(await response.json())
}

export async function saveSettings(settings: AppSettingsUpdate): Promise<SettingsResponse> {
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

export async function fetchGitHubConfig(): Promise<GitHubConfig> {
  const response = await fetch('/api/settings/github')
  if (!response.ok) throw new Error(`GitHub config load failed: ${response.status}`)
  return githubConfigSchema.parse(await response.json())
}

export async function saveGitHubConfig(config: GitHubConfig): Promise<GitHubConfig> {
  const response = await fetch('/api/settings/github', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ? `GitHub config save failed: ${body.error}` : `GitHub config save failed: ${response.status}`)
  }
  return githubConfigSchema.parse(await response.json())
}

export async function fetchSessionTimeline(
  sessionId: string,
  options: { cursor?: string; fromTurnId?: string; anchorTurnId?: string; limitTurns?: number; waitContext?: boolean; pendingSubmissionUuid?: string } = {},
): Promise<SessionTimelineResponse> {
  if ([options.cursor, options.fromTurnId, options.anchorTurnId].filter(Boolean).length > 1) throw new Error('Timeline cursor, fromTurnId, and anchorTurnId are mutually exclusive')
  const params = new URLSearchParams({ limitTurns: String(options.limitTurns ?? 20) })
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.fromTurnId) params.set('fromTurnId', options.fromTurnId)
  if (options.anchorTurnId) params.set('anchorTurnId', options.anchorTurnId)
  if (options.waitContext) params.set('waitContext', 'true')
  if (options.pendingSubmissionUuid) params.set('pendingSubmissionUuid', options.pendingSubmissionUuid)
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    if (response.status === 409 && (body?.error === 'timeline_cursor_stale' || body?.error === 'timeline_invalidation_stale' || body?.error === 'timeline_anchor_stale'))
      throw new TimelineSnapshotStaleError(body.error)
    throw new Error(`Session timeline request failed: ${response.status}`)
  }
  return sessionTimelineResponseSchema.parse(await response.json())
}

export async function fetchSessionProject(sessionId: string): Promise<SessionProjectResponse | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/project`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Session project request failed: ${response.status}`)
  return sessionProjectResponseSchema.parse(await response.json())
}

export async function fetchSessionTimelineControl(sessionId: string, options: { waitContext?: boolean } = {}): Promise<SessionTimelineControlResponse> {
  const params = new URLSearchParams({ scope: 'control' })
  if (options.waitContext) params.set('waitContext', 'true')
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/timeline?${params}`)
  if (!response.ok) throw new Error(`Session timeline control request failed: ${response.status}`)
  return sessionTimelineControlResponseSchema.parse(await response.json())
}

export async function saveTurnOptions(sessionId: string, options: TurnOptionsUpdateRequest): Promise<void> {
  turnOptionsUpdateRequestSchema.parse(options)
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/turn-options`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
  if (!response.ok) throw new Error(`Turn options save failed: ${response.status}`)
}

export async function respondToToolApproval(sessionId: string, requestId: string, decision: ToolApprovalDecisionRequest): Promise<ToolApprovalDecisionResponse> {
  toolApprovalDecisionRequestSchema.parse(decision)
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decision),
  })
  if (!response.ok) throw new Error(`Permission response failed: ${response.status}`)
  return toolApprovalDecisionResponseSchema.parse(await response.json())
}

export async function respondToQuestion(sessionId: string, requestId: string, decision: AskUserQuestionDecisionRequest): Promise<ToolApprovalDecisionResponse> {
  askUserQuestionDecisionRequestSchema.parse(decision)
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decision),
  })
  if (!response.ok) throw new Error(`Question response failed: ${response.status}`)
  return toolApprovalDecisionResponseSchema.parse(await response.json())
}

export async function fetchLocalMessageImage(
  sessionId: string,
  messageUuid: string,
  input: { src: string; confirmedExternal: boolean; confirmedLarge: boolean; expectedConfirmation?: LocalImageConfirmation; agentId?: string },
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageUuid)}/local-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      size?: number
      external?: boolean
      resolvedPath?: string
      confirmation?: LocalImageConfirmation
    } | null
    throw new LocalImageHttpError(response.status, body?.error ?? null, body?.size, body?.external, body?.resolvedPath, body?.confirmation)
  }
  return response.blob()
}

export async function fetchSessionRawMessages(sessionId: string, turnId: string): Promise<SessionRawMessagesResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/raw-messages?turnId=${encodeURIComponent(turnId)}`)
  if (!response.ok) throw new Error(`Session raw messages request failed: ${response.status}`)
  return sessionRawMessagesResponseSchema.parse(await response.json())
}

export async function fetchTurnSubagentsTree(sessionId: string, turnId: string): Promise<TurnSubagentsTreeResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/subagents/tree`)
  if (!response.ok) throw new Error(`Turn subagents tree request failed: ${response.status}`)
  return turnSubagentsTreeResponseSchema.parse(await response.json())
}

export async function fetchTurnSubagentTranscript(sessionId: string, turnId: string, agentId: string): Promise<TurnSubagentTranscriptResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/subagents/${encodeURIComponent(agentId)}/transcript`)
  if (!response.ok) throw new Error(`Turn subagent transcript request failed: ${response.status}`)
  return turnSubagentTranscriptResponseSchema.parse(await response.json())
}

export async function fetchSessionPins(): Promise<SessionPinsResponse> {
  const response = await fetch('/api/session-pins')
  if (!response.ok) throw new Error(`Session pins request failed: ${response.status}`)
  return sessionPinsResponseSchema.parse(await response.json())
}

export async function setSessionPinned(sessionId: string, pinned: boolean): Promise<SessionPinUpdateResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) })
  if (!response.ok) throw new Error(`Session pin request failed: ${response.status}`)
  return sessionPinUpdateResponseSchema.parse(await response.json())
}

export async function deleteSession(projectId: string, sessionId: string, confirmationSessionId: string): Promise<DeleteSessionResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationSessionId }),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    if (body?.error === 'session_not_found_after_interrupt') throw new Error('The session was no longer found during deletion. Refresh the session list.')
    if (body?.error === 'session_delete_failed_after_interrupt') throw new Error('The running turn was interrupted, but the session could not be deleted. You can retry deleting it.')
    if (body?.error === 'session_delete_runtime_close_failed') throw new Error('The running turn could not be stopped, so the session was not deleted. You can retry deleting it.')
    throw new Error(`Session delete request failed: ${response.status}`)
  }
  return deleteSessionResponseSchema.parse(await response.json())
}

export async function renameSession(projectId: string, sessionId: string, title: string): Promise<RenameSessionResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) throw new Error(`Session rename request failed: ${response.status}`)
  return renameSessionResponseSchema.parse(await response.json())
}

export async function forkSession(projectId: string, sessionId: string, upToMessageId?: string): Promise<ForkSessionResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(upToMessageId ? { upToMessageId } : {}),
  })
  if (!response.ok) throw new Error(`Session fork request failed: ${response.status}`)
  return forkSessionResponseSchema.parse(await response.json())
}

export async function refreshProjects(projectId: string | null = null): Promise<void> {
  const path = projectId ? `/api/projects/${encodeURIComponent(projectId)}/refresh` : '/api/projects/refresh'
  const response = await fetch(path, { method: 'POST' })
  if (!response.ok) throw new Error(`Projects refresh request failed: ${response.status}`)
}

export function connectListVersions(onEvent: (event: ListVersionsEvent) => void, onError?: () => void, selected?: { projectId: string; sessionId: string } | null): EventSource {
  const params = new URLSearchParams()
  if (selected) {
    params.set('projectId', selected.projectId)
    params.set('sessionId', selected.sessionId)
  }
  const events = new EventSource(`/api/list-versions/events${params.size ? `?${params}` : ''}`)
  events.onmessage = (message) => {
    onEvent(listVersionsEventSchema.parse(JSON.parse(message.data)))
  }
  if (onError) events.onerror = onError
  return events
}

export async function restartSessionRuntime(sessionId: string): Promise<RestartSessionRuntimeResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restart`, { method: 'POST' })
  if (!response.ok) await throwRequestError(response, 'Session restart')
  return restartSessionRuntimeResponseSchema.parse(await response.json())
}

export async function ensureSessionRuntime(sessionId: string): Promise<SessionRuntimeResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime`, { method: 'POST' })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new SessionRuntimeHttpError(response.status, body?.error ?? null)
  }
  return sessionRuntimeResponseSchema.parse(await response.json())
}
