import { describe, expect, it, vi } from 'vitest'
import { LarkIntegrationService } from './service.js'
import type { ChannelConfig, ConnectorConfig } from '../../config/schema.js'

function createService() {
  const connector: ConnectorConfig = {
    connectorId: 'connector-1',
    connectorType: 'lark',
    connectorConfig: {
      appId: 'app-id',
      appSecret: 'app-secret',
    },
  }
  const channel: ChannelConfig = {
    channelId: 'channel-1',
    channelKey: 'chat-1',
    connectorId: 'connector-1',
    agentId: 'agent-1',
    enabled: true,
  }
  const orchestrator = {
    subscribeSessionEvents: vi.fn(),
    unsubscribeSessionEvents: vi.fn(),
    respondToInteraction: vi.fn().mockResolvedValue({}),
    cancelControl: vi.fn().mockResolvedValue({}),
    dispatchRun: vi.fn().mockResolvedValue({ sessionId: 'session-1', runId: 'run-1' }),
  }
  const configRegistry = {
    listConnectors: vi.fn().mockReturnValue([connector]),
    listChannels: vi.fn().mockReturnValue([channel]),
    getConnector: vi.fn().mockImplementation((connectorId: string) => (
      connectorId === connector.connectorId ? connector : null
    )),
    getChannel: vi.fn().mockImplementation((channelId: string) => (
      channelId === channel.channelId ? channel : null
    )),
    getAgent: vi.fn().mockReturnValue({
      agentId: 'agent-1',
      projectDir: '/tmp/project',
    }),
  }
  const configRepository = {
    getChannelCurrentSdkSessionId: vi.fn().mockReturnValue(null),
    updateChannelCurrentSdkSessionId: vi.fn(),
  }
  const channelBindingService = {
    bindChannel: vi.fn(),
    clearChannel: vi.fn(),
  }
  const sessionRegistry = {
    findByChannelId: vi.fn().mockReturnValue(null),
    get: vi.fn().mockReturnValue(null),
    releaseChannel: vi.fn(),
    ensure: vi.fn().mockReturnValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
    }),
    claimChannel: vi.fn(),
  }
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const service = new LarkIntegrationService({
    configRegistry: configRegistry as never,
    configRepository: configRepository as never,
    channelBindingService: channelBindingService as never,
    sessionRegistry: sessionRegistry as never,
    orchestrator: orchestrator as never,
    logger,
  })

  return { service, orchestrator, configRegistry, configRepository, channelBindingService, sessionRegistry, logger, channel }
}

describe('LarkIntegrationService', () => {
  it('deduplicates repeated card actions so permission responses are only submitted once', async () => {
    const { service, orchestrator } = createService()
    const body = {
      open_message_id: 'message-1',
      action: {
        value: {
          actionType: 'permission',
          sessionId: 'session-1',
          requestId: 'request-1',
          decision: 'approve',
        },
      },
    }

    const first = await service.handleCardAction(body)
    const second = await service.handleCardAction(body)

    expect(first.payload).toMatchObject({
      toast: {
        type: 'success',
        content: 'Permission approved.',
      },
    })
    expect(second.payload).toMatchObject({
      toast: {
        type: 'info',
        content: 'This action was already handled.',
      },
    })
    expect(orchestrator.respondToInteraction).toHaveBeenCalledTimes(1)
    expect(orchestrator.respondToInteraction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      requestId: 'request-1',
      kind: 'permission',
      response: { decision: 'approve' },
    })
  })

  it('serializes per-run event handling to preserve stream ordering', async () => {
    const { service } = createService()
    const order: string[] = []
    const serviceAny = service as any

    vi.spyOn(serviceAny, 'handleWorkerEventInner').mockImplementation(async (...args: unknown[]) => {
      const event = args[0] as { runId: string; step: number }
      order.push(`start:${event.step}`)
      await new Promise((resolve) => setTimeout(resolve, event.step === 1 ? 10 : 0))
      order.push(`end:${event.step}`)
    })

    await Promise.all([
      serviceAny.handleWorkerEvent({ sessionId: 'session-1', runId: 'run-1', step: 1 }),
      serviceAny.handleWorkerEvent({ sessionId: 'session-1', runId: 'run-1', step: 2 }),
    ])
    await (serviceAny.runEventQueueByRunId.get('run-1') ?? Promise.resolve())

    expect(order).toEqual([
      'start:1',
      'end:1',
      'start:2',
      'end:2',
    ])
  })

  it('ignores expired inbound messages before dispatching a run', async () => {
    const { service, orchestrator } = createService()

    await (service as any).handleReceiveMessage('connector-1', {
      sender: {
        sender_type: 'user',
      },
      message: {
        message_id: 'message-1',
        create_time: String(Date.now() - 31 * 60 * 1000),
        chat_id: 'chat-1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    })

    expect(orchestrator.dispatchRun).not.toHaveBeenCalled()
  })

  it('ignores late stream events after a run has already been delivered', async () => {
    const { service, sessionRegistry } = createService()
    sessionRegistry.get.mockReturnValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
    })
    ;((service as any).deliveredRunIds as Set<string>).add('run-1')
    const getOrCreateStreamingController = vi.spyOn(service as any, 'getOrCreateStreamingController')

    await (service as any).handleWorkerEventInner({
      type: 'session.sdk.stream_event',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 1,
      sequence: 1,
      event: {
        type: 'session.sdk.stream_event',
        sessionId: 'session-1',
        runId: 'run-1',
        receivedAt: 1,
        sequence: 1,
        scope: {
          scopeKey: 'session-1:ephemeral:1',
          anchorKind: 'ephemeral',
          anchorId: 'session-1:ephemeral:1',
        },
        event: { type: 'message_delta' },
      },
    })

    expect(getOrCreateStreamingController).not.toHaveBeenCalled()
  })
})
