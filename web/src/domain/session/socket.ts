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
  let ws: WebSocket | null = null
  let sessionFilter: string | null = null
  let reconnectTimer: number | null = null
  let intentionalClose = false

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function disconnect() {
    intentionalClose = true
    clearReconnectTimer()
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

    disconnect()
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
        clearReconnectTimer()
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connect()
        }, reconnectDelayMs)
        options.onReconnectScheduled?.(reconnectDelayMs)
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
