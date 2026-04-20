export interface SettingsResponse {
  path: string
  exists: boolean
  updatedAt: number | null
  raw: string
}

import { extractApiError, makeApiResult, readJsonSafe, type ApiResult } from './result'

export interface SettingsSaveData {
  updatedAt: number | null
}

export async function fetchSettingsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<SettingsResponse | null>> {
  const res = await apiFetch('/api/settings')
  const payload = await readJsonSafe(res) as SettingsResponse | { error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: payload && typeof payload === 'object' && 'path' in payload ? payload as SettingsResponse : null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function saveSettingsRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  raw: string,
): Promise<ApiResult<SettingsSaveData | null>> {
  const res = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  const body = await readJsonSafe(res) as { updatedAt?: number | null; error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: res.ok ? { updatedAt: typeof body?.updatedAt === 'number' ? body.updatedAt : null } : null,
    error: res.ok ? null : extractApiError(body, res.status),
  })
}
