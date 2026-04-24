import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LarkClientManager } from './client-manager.js'

const registerSpy = vi.fn()
const startSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockEventDispatcher {
    register(handlers: Record<string, unknown>) {
      registerSpy(handlers)
      return this
    }
  }

  class MockClient {}

  class MockWSClient {
    start = startSpy
  }

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    Domain: { Feishu: 'feishu' },
    LoggerLevel: { warn: 'warn' },
  }
})

describe('LarkClientManager', () => {
  beforeEach(() => {
    registerSpy.mockClear()
    startSpy.mockClear()
  })

  it('registers only supported long-connection event handlers', async () => {
    const connector = {
      connectorId: 'connector-1',
      connectorType: 'lark',
      connectorConfig: {
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    }
    const manager = new LarkClientManager({
      configRegistry: {
        listConnectors: () => [connector],
        getConnector: (connectorId: string) => connectorId === connector.connectorId ? connector : null,
      } as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      onReceiveMessage: vi.fn().mockResolvedValue(undefined),
    })

    await manager.startLongConnection('connector-1')

    expect(registerSpy).toHaveBeenCalledTimes(1)
    const handlers = registerSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(handlers).sort()).toEqual([
      'im.message.message_read_v1',
      'im.message.receive_v1',
    ])
    expect(handlers['card.action.trigger']).toBeUndefined()
    expect(startSpy).toHaveBeenCalledTimes(1)
  })
})
