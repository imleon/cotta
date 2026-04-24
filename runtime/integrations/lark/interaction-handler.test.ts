import { describe, expect, it, vi } from 'vitest'
import { LarkInteractionHandler } from './interaction-handler.js'

describe('LarkInteractionHandler', () => {
  it('renders elicitation prompt and accepts /answer response', async () => {
    const orchestrator = {
      respondToInteraction: vi.fn().mockResolvedValue({}),
      cancelControl: vi.fn().mockResolvedValue({}),
    }
    const sessionRegistry = {
      findByChannelId: vi.fn().mockReturnValue({ sessionId: 'session-1' }),
    }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sendText = vi.fn().mockResolvedValue(undefined)
    const sendCard = vi.fn().mockResolvedValue(undefined)

    const handler = new LarkInteractionHandler({
      orchestrator: orchestrator as never,
      sessionRegistry: sessionRegistry as never,
      logger,
      sendText,
      sendCard,
    })

    const channel = {
      channelId: 'channel-1',
      channelKey: 'chat-1',
      connectorId: 'connector-1',
      agentId: 'agent-1',
      enabled: true,
    }

    await handler.handleAwaitingUser('session-1', channel as never, {
      id: 'req-1',
      kind: 'elicitation',
      status: 'pending',
      source: { kind: 'control', subtype: 'elicitation' },
      blocksRun: true,
      serverName: 'mcp',
      message: 'Provide name',
      requestedSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Name' },
        },
        required: ['name'],
      },
    } as any)

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(String(sendText.mock.calls[0][1])).toContain('/answer req-1')

    const command = handler.parseCommand('/answer req-1 Alice')
    expect(command).toMatchObject({ type: 'elicitation', requestId: 'req-1', action: 'accept' })

    await handler.handleCommand(channel as never, command as any)

    expect(orchestrator.respondToInteraction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      requestId: 'req-1',
      kind: 'elicitation',
      response: {
        action: 'accept',
        content: { name: 'Alice' },
      },
    })
  })
})

