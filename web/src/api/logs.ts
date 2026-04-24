import type {
  SessionPersistentLogEntry,
  SessionSdkRawLogEntry,
} from '../contract/runtime'
import type { PersistentLogsResponse, SdkRawLogsResponse } from './types'
import { extractApiError, makeApiResult, readJsonSafe, type ApiResult } from './result'

export interface SdkRawLogsData {
  items: SessionSdkRawLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

export interface PersistentLogsData {
  items: SessionPersistentLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

function buildLogSearchParams(options: { limit: number; full?: boolean; cursor?: number | null; follow?: boolean }): string {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit))
  if (options.full) params.set('full', '1')
  if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor))
  if (options.follow) params.set('follow', '1')
  return params.toString()
}

export async function fetchSdkRawLogsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  options: { limit: number; full?: boolean; cursor?: number | null; follow?: boolean },
): Promise<ApiResult<SdkRawLogsData>> {
  const res = await apiFetch(`/api/sessions/${sessionId}/sdk-raw-logs?${buildLogSearchParams(options)}`)
  const payload = await readJsonSafe(res)
  if (!res.ok) {
    return makeApiResult({
      ok: false,
      status: res.status,
      data: { items: [], hasMore: false, nextCursor: null },
      error: extractApiError(payload, res.status),
    })
  }

  const data = payload as SdkRawLogsResponse
  return makeApiResult({
    ok: true,
    status: res.status,
    data: {
      items: Array.isArray(data.items) ? data.items : [],
      hasMore: Boolean(data.hasMore),
      nextCursor: typeof data.nextCursor === 'number' ? data.nextCursor : null,
    },
  })
}

export async function fetchPersistentLogsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  options: { limit: number; full?: boolean; cursor?: number | null; follow?: boolean },
): Promise<ApiResult<PersistentLogsData>> {
  const res = await apiFetch(`/api/sessions/${sessionId}/persistent-logs?${buildLogSearchParams(options)}`)
  const payload = await readJsonSafe(res)
  if (!res.ok) {
    return makeApiResult({
      ok: false,
      status: res.status,
      data: {
        items: [],
        hasMore: false,
        nextCursor: null,
      },
      error: extractApiError(payload, res.status),
    })
  }

  const data = payload as PersistentLogsResponse
  return makeApiResult({
    ok: true,
    status: res.status,
    data: {
      items: Array.isArray(data.items) ? data.items : [],
      hasMore: Boolean(data.hasMore),
      nextCursor: typeof data.nextCursor === 'number' ? data.nextCursor : null,
    },
  })
}
