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
    hasLarkInboundReceipt: vi.fn().mockReturnValue(false),
    recordLarkInboundReceipt: vi.fn(),
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

  it('uses app_id hint to narrow inbound dispatch attempts', async () => {
    const { service, configRegistry } = createService()
    const connector2 = {
      connectorId: 'connector-2',
      connectorType: 'lark',
      connectorConfig: {
        appId: 'app-id-2',
        appSecret: 'secret-2',
      },
    }
    configRegistry.listConnectors.mockReturnValue([
      configRegistry.getConnector('connector-1'),
      connector2,
    ])
    configRegistry.getConnector.mockImplementation((connectorId: string) => {
      if (connectorId === 'connector-1') {
        return {
          connectorId: 'connector-1',
          connectorType: 'lark',
          connectorConfig: { appId: 'app-id', appSecret: 'app-secret' },
        }
      }
      if (connectorId === 'connector-2') return connector2
      return null
    })
    const connector1Dispatcher = { invoke: vi.fn().mockResolvedValue(undefined) }
    const connector2Dispatcher = { invoke: vi.fn().mockResolvedValue(undefined) }
    vi.spyOn((service as any).clientManager, 'getDispatcher').mockImplementation((connectorId: unknown) => {
      return connectorId === 'connector-1' ? connector1Dispatcher : connector2Dispatcher
    })

    const result = await service.handleInbound({
      header: {
        app_id: 'app-id-2',
      },
      event: {},
    })

    expect(result).toEqual({ status: 200, payload: { ok: true } })
    expect(connector1Dispatcher.invoke).not.toHaveBeenCalled()
    expect(connector2Dispatcher.invoke).toHaveBeenCalledTimes(1)
  })

  it('logs classified connector mismatches before returning unmatched inbound', async () => {
    const { service, logger } = createService()
    vi.spyOn((service as any).clientManager, 'getDispatcher').mockReturnValue({
      invoke: vi.fn().mockRejectedValue(new Error('invalid token')),
    })

    const result = await service.handleInbound({
      header: {
        app_id: 'unknown-app',
      },
      event: {},
    })

    expect(result).toEqual({ status: 400, payload: { error: 'No matching lark connector' } })
    expect(logger.warn).toHaveBeenCalledWith('lark:inbound:unmatched', expect.objectContaining({
      appIdHint: 'unknown-app',
    }))
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

  it('skips inbound messages that were already persisted as processed', async () => {
    const { service, orchestrator, configRepository } = createService()
    configRepository.hasLarkInboundReceipt.mockReturnValue(true)

    await (service as any).handleReceiveMessage('connector-1', {
      sender: {
        sender_type: 'user',
      },
      message: {
        message_id: 'message-1',
        create_time: String(Date.now()),
        chat_id: 'chat-1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    })

    expect(orchestrator.dispatchRun).not.toHaveBeenCalled()
    expect(configRepository.recordLarkInboundReceipt).not.toHaveBeenCalled()
  })

  it('removes in-memory dedupe on dispatch failure so retries remain possible', async () => {
    const { service, orchestrator, configRepository } = createService()
    orchestrator.dispatchRun.mockRejectedValue(new Error('dispatch failed'))
    const sessionRegistry = (service as any).deps.sessionRegistry
    sessionRegistry.get.mockReturnValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
    })

    await expect((service as any).handleReceiveMessage('connector-1', {
      sender: {
        sender_type: 'user',
      },
      message: {
        message_id: 'message-1',
        create_time: String(Date.now()),
        chat_id: 'chat-1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    })).rejects.toThrow('dispatch failed')

    expect(((service as any).inboundMessageSeenAt as Map<string, number>).has('chat-1:message-1')).toBe(false)
    expect(configRepository.recordLarkInboundReceipt).not.toHaveBeenCalled()
  })

  it('ignores late stream events after a run has already been delivered', async () => {
    const { service, sessionRegistry } = createService()
    sessionRegistry.get.mockReturnValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
    })
    ;((service as any).deliveredRunIds as Map<string, number>).set('run-1', Date.now())
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

  it('releases run-scoped state when final delivery fails', async () => {
    const { service, sessionRegistry, logger } = createService()
    sessionRegistry.get.mockReturnValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
    })
    ;((service as any).replyContextByRunId as Map<string, unknown>).set('run-1', { chatId: 'chat-1' })
    ;((service as any).latestAssistantTextByRunId as Map<string, string>).set('run-1', 'hello')
    ;((service as any).latestAssistantMessageByRunId as Map<string, unknown>).set('run-1', { role: 'assistant' })
    ;((service as any).runStartedAtByRunId as Map<string, number>).set('run-1', Date.now())
    ;((service as any).typingReactionByRunId as Map<string, unknown>).set('run-1', {
      sourceMessageId: 'message-1',
      reactionId: 'reaction-1',
    })
    ;((service as any).materializedMessagesByRunId as Map<string, unknown>).set('run-1', [{ role: 'assistant' }])
    ;((service as any).latestResultPayloadByRunId as Map<string, unknown>).set('run-1', { ok: true })
    ;((service as any).streamControllersByRunId as Map<string, unknown>).set('run-1', {
      dispose: vi.fn(),
    })
    vi.spyOn(service as any, 'clearTypingReaction').mockRejectedValue(new Error('cleanup boom'))
    vi.spyOn(service as any, 'buildFinalCardForRun').mockResolvedValue({ type: 'card' })
    vi.spyOn(service as any, 'createCardKitMessage').mockRejectedValue(new Error('send boom'))

    await (service as any).handleWorkerEventInner({
      type: 'session.run.completed',
      sessionId: 'session-1',
      runId: 'run-1',
      resultPayload: { ok: true },
    })

    expect(logger.error).toHaveBeenCalledWith('lark:message:send:error', expect.objectContaining({
      runId: 'run-1',
    }))
    expect(logger.error).toHaveBeenCalledWith('lark:typing:cleanup:error', expect.objectContaining({
      runId: 'run-1',
    }))
    expect(((service as any).replyContextByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).latestAssistantTextByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).latestAssistantMessageByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).runStartedAtByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).typingReactionByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).materializedMessagesByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).latestResultPayloadByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).streamControllersByRunId as Map<string, unknown>).has('run-1')).toBe(false)
    expect(((service as any).deliveredRunIds as Map<string, number>).has('run-1')).toBe(false)
  })

  it('marks deliveredRunIds only after a terminal message is delivered successfully', async () => {
    const { service, sessionRegistry } = createService()
    sessionRegistry.get.mockReturnValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      channelId: 'channel-1',
    })
    ;((service as any).latestAssistantTextByRunId as Map<string, string>).set('run-1', 'hello')
    vi.spyOn(service as any, 'buildFinalCardForRun').mockResolvedValue({ type: 'card' })
    vi.spyOn(service as any, 'createCardKitMessage').mockResolvedValue({ messageId: 'msg-1', cardId: 'card-1' })
    vi.spyOn(service as any, 'clearTypingReaction').mockResolvedValue(undefined)

    await (service as any).handleWorkerEventInner({
      type: 'session.run.completed',
      sessionId: 'session-1',
      runId: 'run-1',
      resultPayload: { ok: true },
    })

    expect(((service as any).deliveredRunIds as Map<string, number>).has('run-1')).toBe(true)
  })
})
