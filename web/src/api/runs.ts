import type { ApiResult } from './result'
import { extractApiError, makeApiResult, readJsonSafe } from './result'

export interface RunCreateData {
  runId: string | null
  activeRunId: string | null
  sessionStatus: string | null
}

export async function createRunRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  input: {
    sessionId: string
    agentId: string
    text: string
    mode?: string
  },
): Promise<ApiResult<RunCreateData>> {
  const res = await apiFetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await readJsonSafe(res) as Record<string, unknown> | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: {
      runId: typeof payload?.runId === 'string' ? payload.runId : null,
      activeRunId: typeof payload?.activeRunId === 'string' ? payload.activeRunId : null,
      sessionStatus: typeof payload?.sessionStatus === 'string' ? payload.sessionStatus : null,
    },
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}
