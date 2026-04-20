import type { SessionMessage } from '../contract/runtime'
import type { ApiResult } from './result'
import { extractApiError, makeApiResult, readJsonSafe } from './result'
import type { SessionMessagesResponse } from './types'

export interface SessionMessagesData {
  messages: SessionMessage[]
  hasMore: boolean
  nextBefore: string | null
}

export interface SessionsListData {
  sessions: unknown[]
}

export type SessionInteractionResponseInput =
  | {
      kind: 'permission'
      requestId: string
      response: {
        decision: 'approve' | 'deny'
        selectedSuggestion?: unknown
        content?: Record<string, string | number | boolean | string[]>
      }
    }
  | {
      kind: 'elicitation'
      requestId: string
      response: {
        action: 'accept' | 'decline' | 'cancel'
        content?: Record<string, unknown>
      }
    }

export async function loadSessionMessagesRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  options: { limit: number; before?: string | null },
): Promise<ApiResult<SessionMessagesData>> {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit))
  if (options.before) params.set('before', options.before)

  const res = await apiFetch(`/api/sessions/${sessionId}/messages?${params.toString()}`)
  const payload = await readJsonSafe(res)
  if (!res.ok) {
    return makeApiResult({
      ok: false,
      status: res.status,
      data: { messages: [], hasMore: false, nextBefore: null },
      error: extractApiError(payload, res.status),
    })
  }

  const data = payload as SessionMessagesResponse
  const messages = (data.messages || []).filter((message): message is SessionMessage => Boolean(message && typeof message === 'object'))
  return makeApiResult({
    ok: true,
    status: res.status,
    data: {
      messages,
      hasMore: Boolean(data.hasMore),
      nextBefore: typeof data.nextBefore === 'string' && data.nextBefore ? data.nextBefore : null,
    },
  })
}

export async function fetchSessionsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<SessionsListData>> {
  const res = await apiFetch('/api/sessions')
  const payload = await readJsonSafe(res)
  if (!res.ok) {
    return makeApiResult({
      ok: false,
      status: res.status,
      data: { sessions: [] },
      error: extractApiError(payload, res.status),
    })
  }
  const data = payload as { sessions?: unknown[] } | null
  return makeApiResult({
    ok: true,
    status: res.status,
    data: { sessions: Array.isArray(data?.sessions) ? data.sessions : [] },
  })
}

export async function stopSessionRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
): Promise<ApiResult<null>> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  })
  const payload = await readJsonSafe(res)
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function rebuildSessionRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
): Promise<ApiResult<null>> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/rebuild`, {
    method: 'POST',
  })
  const payload = await readJsonSafe(res)
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function requestSessionControl(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  subtype: 'interrupt' | 'get_context_usage' | 'mcp_status',
): Promise<ApiResult<null>> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtype }),
  })
  const payload = await readJsonSafe(res)
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function respondToSessionInteractionRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  input: SessionInteractionResponseInput,
): Promise<ApiResult<null>> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/control/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: input.requestId,
      kind: input.kind,
      response: input.response,
    }),
  })
  const payload = await readJsonSafe(res)
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function cancelSessionInteractionRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  requestId: string,
): Promise<ApiResult<null>> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/control/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  })
  const payload = await readJsonSafe(res)
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}
