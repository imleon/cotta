import type { StatusResponse } from './types'
import { extractApiError, makeApiResult, readJsonSafe, type ApiResult } from './result'

export async function fetchStatusRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<StatusResponse | null>> {
  const res = await apiFetch('/api/status')
  const body = await readJsonSafe(res) as StatusResponse | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: body,
    error: res.ok ? null : extractApiError(body, res.status),
  })
}
