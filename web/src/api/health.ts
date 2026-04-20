import type { ApiResult } from './result'
import { extractApiError, makeApiResult, readJsonSafe } from './result'

export interface HealthData {
  status: string | null
  authEnabled: boolean
}

export async function fetchHealthRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<HealthData>> {
  const res = await apiFetch('/api/health')
  const payload = await readJsonSafe(res) as Record<string, unknown> | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: {
      status: typeof payload?.status === 'string' ? payload.status : null,
      authEnabled: Boolean(payload?.authEnabled),
    },
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}
