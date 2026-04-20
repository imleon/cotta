export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T
  error: string | null
}

export async function readJsonSafe(response: Response): Promise<unknown | null> {
  return await response.json().catch(() => null)
}

export function extractApiError(payload: unknown, fallbackStatus: number): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error: unknown }).error === 'string') {
    return (payload as { error: string }).error
  }
  return fallbackStatus >= 400 ? `HTTP ${fallbackStatus}` : null
}

export function makeApiResult<T>(input: {
  ok: boolean
  status: number
  data: T
  error?: string | null
}): ApiResult<T> {
  return {
    ok: input.ok,
    status: input.status,
    data: input.data,
    error: input.error ?? null,
  }
}
