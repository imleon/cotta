import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreateTurnHttpError, createCottaApi } from '../api'
import { type CottaTransport, createSameOriginTransport } from './transport'

function recordingTransport() {
  const calls: Array<{ kind: 'fetch' | 'eventSource' | 'webSocket'; path: string; init?: RequestInit }> = []
  const eventSource = { close: vi.fn() } as unknown as EventSource
  const webSocket = { close: vi.fn() } as unknown as WebSocket
  let nextResponse: Response = Response.json({})
  const transport: CottaTransport = {
    fetch: async (path, init) => {
      calls.push({ kind: 'fetch', path, ...(init ? { init } : {}) })
      return nextResponse
    },
    eventSource: (path) => {
      calls.push({ kind: 'eventSource', path })
      return eventSource
    },
    webSocket: (path) => {
      calls.push({ kind: 'webSocket', path })
      return webSocket
    },
    resolveUrl: (path) => `https://target.example${path}`,
  }
  return {
    transport,
    calls,
    eventSource,
    webSocket,
    respond: (response: Response) => {
      nextResponse = response
    },
  }
}

describe('createCottaApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes HTTP, event streams and sockets through its own transport, never the page globals', async () => {
    const globalFetch = vi.fn()
    const GlobalEventSource = vi.fn()
    const GlobalWebSocket = vi.fn()
    vi.stubGlobal('fetch', globalFetch)
    vi.stubGlobal('EventSource', GlobalEventSource)
    vi.stubGlobal('WebSocket', GlobalWebSocket)
    const target = recordingTransport()
    const api = createCottaApi(target.transport)

    target.respond(Response.json({ sessionId: 's/1', turnId: 't1', projectId: 'p1' }))
    await api.createTurn('p1', 's/1', 's/1', 'hello', [], 'uuid-1').catch(() => undefined)
    target.respond(new Response(null, { status: 204 }))
    await api.interruptTurn('s/1')
    expect(api.connectSessionEvents('s/1')).toBe(target.eventSource)
    expect(api.connectProjectFileEvents('p/1', new URLSearchParams({ file: 'a b' }))).toBe(target.eventSource)
    expect(api.connectTerminal()).toBe(target.webSocket)
    target.respond(Response.json({ available: true }))
    await expect(api.fetchTerminalAvailability()).resolves.toBe(true)

    expect(target.calls.map(({ kind, path, init }) => [kind, path, init?.method ?? null])).toEqual([
      ['fetch', '/api/sessions/s%2F1/turns', 'POST'],
      ['fetch', '/api/sessions/s%2F1/interrupt', 'POST'],
      ['eventSource', '/api/sessions/s%2F1/events', null],
      ['eventSource', '/api/projects/p%2F1/files/events?file=a+b', null],
      ['webSocket', '/api/terminal', null],
      ['fetch', '/api/terminal', null],
    ])
    expect(globalFetch).not.toHaveBeenCalled()
    expect(GlobalEventSource).not.toHaveBeenCalled()
    expect(GlobalWebSocket).not.toHaveBeenCalled()
  })

  it('keeps two instances bound to their own targets', async () => {
    const first = recordingTransport()
    const second = recordingTransport()
    const firstApi = createCottaApi(first.transport)
    const secondApi = createCottaApi(second.transport)
    second.respond(Response.json({ available: false }))

    await expect(secondApi.fetchTerminalAvailability()).resolves.toBe(false)
    firstApi.connectSessionEvents('s1')

    expect(first.calls.map((call) => call.path)).toEqual(['/api/sessions/s1/events'])
    expect(second.calls.map((call) => call.path)).toEqual(['/api/terminal'])
  })

  it('reports the server error message when a turn is rejected', async () => {
    const target = recordingTransport()
    target.respond(Response.json({ error: 'session_busy' }, { status: 409 }))
    const api = createCottaApi(target.transport)

    const failure = api.createTurn('p1', null, 's1', 'hi', [], 'uuid-1')

    await expect(failure).rejects.toBeInstanceOf(CreateTurnHttpError)
    await expect(failure).rejects.toThrow('session_busy')
    expect(target.calls[0]).toMatchObject({ path: '/api/projects/p1/sessions', init: { method: 'POST' } })
  })
})

describe('createSameOriginTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls fetch with exactly the arguments given, resolved at call time', async () => {
    const transport = createSameOriginTransport()
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await transport.fetch('/api/projects')
    await transport.fetch('/api/terminal', { method: 'DELETE' })

    expect(fetchMock.mock.calls).toEqual([['/api/projects'], ['/api/terminal', { method: 'DELETE' }]])
  })

  it('opens sockets on the page host with the matching scheme and leaves URLs same-origin', () => {
    const WebSocketMock = vi.fn()
    vi.stubGlobal('WebSocket', WebSocketMock)
    const transport = createSameOriginTransport()

    vi.stubGlobal('location', { protocol: 'https:', host: 'cotta.example:8443' })
    transport.webSocket('/api/terminal')
    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:3000' })
    transport.webSocket('/api/terminal')

    expect(WebSocketMock.mock.calls).toEqual([['wss://cotta.example:8443/api/terminal'], ['ws://127.0.0.1:3000/api/terminal']])
    expect(transport.resolveUrl('/api/share/t/asset?src=a')).toBe('/api/share/t/asset?src=a')
  })
})
