import { extractApiError, makeApiResult, readJsonSafe, type ApiResult } from './result'

export type ChannelBoundSession = {
  sessionId: string
  title?: string
  updatedAt: number
  sessionStatus?: string
  activeRunId?: string
}

export type ChannelCandidateSession = {
  sessionId: string
  title?: string
  updatedAt: number
  isCurrent: boolean
  claimedByChannelId?: string
}

export type ChannelSessionBindingItem = {
  channelId: string
  boundSession: ChannelBoundSession | null
  candidateSessions: ChannelCandidateSession[]
}

export async function fetchChannelBindingsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<ChannelSessionBindingItem[]>> {
  const res = await apiFetch('/api/channels/session-bindings')
  const payload = await readJsonSafe(res) as { items?: ChannelSessionBindingItem[]; error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: Array.isArray(payload?.items) ? payload.items : [],
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function bindChannelToExistingSessionRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  input: { channelId: string; sessionId: string },
): Promise<ApiResult<ChannelSessionBindingItem | null>> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(input.channelId)}/session-binding/use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: input.sessionId }),
  })
  const payload = await readJsonSafe(res) as { item?: ChannelSessionBindingItem; error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: payload?.item ?? null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function bindChannelToNewSessionRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  channelId: string,
): Promise<ApiResult<ChannelSessionBindingItem | null>> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(channelId)}/session-binding/new`, {
    method: 'POST',
  })
  const payload = await readJsonSafe(res) as { item?: ChannelSessionBindingItem; error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: payload?.item ?? null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}
