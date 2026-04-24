import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateReconnectDelayMs, createSessionSocketController } from './socket'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3

  readonly url: string
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emitClose(input: { code?: number; reason?: string; wasClean?: boolean } = {}) {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({
      code: input.code ?? 1006,
      reason: input.reason ?? '',
      wasClean: input.wasClean ?? false,
    } as CloseEvent)
  }
}

describe('socket', () => {
  afterEach(() => {
    FakeWebSocket.instances = []
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubWindow() {
    vi.stubGlobal('window', {
      location: new URL('http://localhost:5173'),
      setTimeout,
      clearTimeout,
    } as unknown as Window & typeof globalThis)
  }

  it('calculates exponential reconnect delays with bounded jitter', () => {
    expect(calculateReconnectDelayMs({
      attempt: 0,
      baseDelayMs: 3000,
      maxDelayMs: 30000,
      random: () => 0,
    })).toBe(2400)
    expect(calculateReconnectDelayMs({
      attempt: 1,
      baseDelayMs: 3000,
      maxDelayMs: 30000,
      random: () => 0.5,
    })).toBe(6000)
    expect(calculateReconnectDelayMs({
      attempt: 10,
      baseDelayMs: 3000,
      maxDelayMs: 30000,
      random: () => 1,
    })).toBe(30000)
  })

  it('backs off reconnect attempts and resets after a successful open', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket as never)
    stubWindow()

    const scheduled: number[] = []
    const controller = createSessionSocketController({
      getSessionId: () => 'session-1',
      getAuthToken: () => 'token',
      getHasAuthToken: () => true,
      getAuthRequired: () => false,
      onBlocked: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      onRawMessage: vi.fn(),
      onReconnectScheduled: (delayMs) => {
        scheduled.push(delayMs)
      },
      shouldReconnect: () => true,
      reconnectDelayMs: 3000,
      reconnectMaxDelayMs: 30000,
      random: () => 0.5,
    })

    controller.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.instances[0].emitClose()
    expect(scheduled).toEqual([3000])

    vi.advanceTimersByTime(3000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1].emitClose()
    expect(scheduled).toEqual([3000, 6000])

    vi.advanceTimersByTime(6000)
    expect(FakeWebSocket.instances).toHaveLength(3)

    FakeWebSocket.instances[2].emitOpen()
    FakeWebSocket.instances[2].emitClose()
    expect(scheduled).toEqual([3000, 6000, 3000])
  })

  it('does not reconnect after an intentional disconnect', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket as never)
    stubWindow()

    const onReconnectScheduled = vi.fn()
    const controller = createSessionSocketController({
      getSessionId: () => 'session-1',
      getAuthToken: () => 'token',
      getHasAuthToken: () => true,
      getAuthRequired: () => false,
      onBlocked: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      onRawMessage: vi.fn(),
      onReconnectScheduled,
      shouldReconnect: () => true,
      random: () => 0.5,
    })

    controller.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)

    controller.disconnect()
    FakeWebSocket.instances[0].emitClose()

    vi.runAllTimers()
    expect(onReconnectScheduled).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
