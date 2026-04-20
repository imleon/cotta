export interface ApiFetchOptions {
  authToken?: string | null
  onUnauthorized?: () => void
  onRequest?: (input: string, init: RequestInit) => void
}

export async function apiFetch(input: string, init: RequestInit = {}, options: ApiFetchOptions = {}) {
  const headers = new Headers(init.headers || undefined)
  const authToken = options.authToken?.trim()
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`)
  }

  const requestInit: RequestInit = {
    ...init,
    headers,
  }

  options.onRequest?.(input, requestInit)

  const res = await fetch(input, requestInit)
  if (res.status === 401) {
    options.onUnauthorized?.()
  }
  return res
}
