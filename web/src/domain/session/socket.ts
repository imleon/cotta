export interface SessionSocketCloseInfo {
  code: number
  reason: string
  wasClean: boolean
}

export interface SessionSocketControllerOptions {
  getSessionId: () => string | null
  getAuthToken: () => string
  getHasAuthToken: () => boolean
  getAuthRequired: () => boolean
  onBlocked: () => void
  onConnectStart?: (url: URL, sessionId: string | null) => void
  onOpen: (sessionId: string | null) => void
  onClose: (info: SessionSocketCloseInfo) => void
  onError: () => void
  onRawMessage: (data: string) => void
  onBeforeDisconnect?: (readyState: number) => void
  onReconnectScheduled?: (delayMs: number) => void
  shouldReconnect: () => boolean
  reconnectDelayMs?: number
  reconnectMaxDelayMs?: number
  random?: () => number
}

export function calculateReconnectDelayMs(input: {
  attempt: number
  baseDelayMs: number
  maxDelayMs: number
  random?: () => number
}): number {
  const attempt = Math.max(0, input.attempt)
  const baseDelayMs = Math.max(1, input.baseDelayMs)
  const maxDelayMs = Math.max(baseDelayMs, input.maxDelayMs)
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt))
  const jitterWindow = Math.round(exponentialDelay * 0.2)
  const random = input.random ?? Math.random
  const jittered = exponentialDelay - jitterWindow + Math.round(random() * jitterWindow * 2)
  return Math.max(250, Math.min(maxDelayMs, jittered))
}

export function buildSessionWsUrl(input: {
  location: Location
  authToken: string
  hasAuthToken: boolean
  sessionId?: string | null
}): URL {
  const protocol = input.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = new URL(`${protocol}//${input.location.host}/ws`)
  if (input.hasAuthToken) {
    wsUrl.searchParams.set('auth', input.authToken)
  }
  if (input.sessionId) {
    wsUrl.searchParams.set('sessionId', input.sessionId)
  }
  return wsUrl
}

export function createSessionSocketController(options: SessionSocketControllerOptions) {
  const reconnectDelayMs = options.reconnectDelayMs ?? 3000
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000
  let ws: WebSocket | null = null
  let sessionFilter: string | null = null
  let reconnectTimer: number | null = null
  let intentionalClose = false
  let reconnectAttempt = 0

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function disconnect(resetReconnectState: boolean = true) {
    intentionalClose = true
    clearReconnectTimer()
    if (resetReconnectState) {
      reconnectAttempt = 0
    }
    if (ws) {
      options.onBeforeDisconnect?.(ws.readyState)
      ws.onclose = null
      ws.close()
      ws = null
    }
    sessionFilter = null
  }

  function connect() {
    if (options.getAuthRequired() && !options.getHasAuthToken()) {
      options.onBlocked()
      return
    }

    disconnect(false)
    intentionalClose = false

    const sessionId = options.getSessionId()
    sessionFilter = sessionId
    const wsUrl = buildSessionWsUrl({
      location: window.location,
      authToken: options.getAuthToken(),
      hasAuthToken: options.getHasAuthToken(),
      sessionId,
    })
    options.onConnectStart?.(wsUrl, sessionId)

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      reconnectAttempt = 0
      options.onOpen(sessionId)
    }

    ws.onclose = (event: CloseEvent) => {
      ws = null
      sessionFilter = null
      options.onClose({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (!intentionalClose && options.shouldReconnect()) {
        const delayMs = calculateReconnectDelayMs({
          attempt: reconnectAttempt,
          baseDelayMs: reconnectDelayMs,
          maxDelayMs: reconnectMaxDelayMs,
          random: options.random,
        })
        reconnectAttempt += 1
        clearReconnectTimer()
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connect()
        }, delayMs)
        options.onReconnectScheduled?.(delayMs)
      }
    }

    ws.onerror = () => {
      options.onError()
    }

    ws.onmessage = (event: MessageEvent) => {
      options.onRawMessage(String(event.data))
    }
  }

  function isOpenForSession(sessionId?: string | null): boolean {
    return Boolean(ws && ws.readyState === WebSocket.OPEN && sessionFilter === (sessionId ?? null))
  }

  return {
    connect,
    disconnect,
    isOpenForSession,
    getSessionFilter: () => sessionFilter,
  }
}
