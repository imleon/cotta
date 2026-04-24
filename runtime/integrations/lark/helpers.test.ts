import { describe, expect, it } from 'vitest'
import {
  applyLarkReplyMentionToText,
  buildFooterFromResultPayload,
  findLarkChannelByConversationKey,
  hasMeaningfulFooter,
  listEnabledLarkChannels,
  listLarkConnectors,
  parseLarkInteractionCommand,
  parseLarkTextContent,
} from './helpers.js'

describe('lark helpers', () => {
  it('parses interaction commands into structured actions', () => {
    expect(parseLarkInteractionCommand('/permission req-1 approve')).toEqual({
      type: 'permission',
      requestId: 'req-1',
      decision: 'approve',
    })
    expect(parseLarkInteractionCommand('/permission session-1 req-2 deny')).toEqual({
      type: 'permission',
      sessionId: 'session-1',
      requestId: 'req-2',
      decision: 'deny',
    })
    expect(parseLarkInteractionCommand('/session use session-2')).toEqual({
      type: 'session',
      action: 'use',
      sessionId: 'session-2',
    })
    expect(parseLarkInteractionCommand('/stop')).toEqual({ type: 'stop' })
    expect(parseLarkInteractionCommand('/answer req-3 hello')).toEqual({
      type: 'elicitation',
      requestId: 'req-3',
      action: 'accept',
      payload: 'hello',
      payloadFormat: 'text',
    })
    expect(parseLarkInteractionCommand('/answer-json req-4 {"a":1}')).toEqual({
      type: 'elicitation',
      requestId: 'req-4',
      action: 'accept',
      payload: '{"a":1}',
      payloadFormat: 'json',
    })
    expect(parseLarkInteractionCommand('/decline req-5')).toEqual({
      type: 'elicitation',
      requestId: 'req-5',
      action: 'decline',
    })
    expect(parseLarkInteractionCommand('/permission bad')).toMatchObject({
      type: 'invalid',
      scope: 'permission',
    })
    expect(parseLarkInteractionCommand('/answer bad')).toMatchObject({
      type: 'invalid',
      scope: 'elicitation',
    })
  })

  it('extracts text payloads and falls back to raw input', () => {
    expect(parseLarkTextContent(JSON.stringify({ text: ' hello ' }))).toBe('hello')
    expect(parseLarkTextContent('plain text')).toBe('plain text')
  })

  it('applies reply mentions only for group replies', () => {
    expect(applyLarkReplyMentionToText('hello', {
      replyToMessageId: 'message-1',
      chatType: 'group',
      senderOpenId: 'ou_1',
    })).toBe('<at user_id="ou_1"></at>\nhello')
    expect(applyLarkReplyMentionToText('hello', {
      replyToMessageId: 'message-1',
      chatType: 'p2p',
      senderOpenId: 'ou_1',
    })).toBe('hello')
  })

  it('builds meaningful footer metadata from result payloads', () => {
    const footer = buildFooterFromResultPayload({
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
      modelUsage: {
        'claude-sonnet': {
          inputTokens: 10,
        },
      },
    }, 123)

    expect(footer).toMatchObject({
      completedAt: 123,
      stopReason: 'end_turn',
      model: 'claude-sonnet',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
      },
    })
    expect(hasMeaningfulFooter(footer)).toBe(true)
    expect(hasMeaningfulFooter(null)).toBe(false)
  })

  it('filters connectors and enabled channels by lark availability', () => {
    const larkConnector = {
      connectorId: 'connector-1',
      connectorType: 'lark',
      connectorConfig: { appId: 'app', appSecret: 'secret' },
    }
    const otherConnector = {
      connectorId: 'connector-2',
      connectorType: 'discord',
      connectorConfig: {},
    }
    const configRegistry = {
      listConnectors: () => [larkConnector, otherConnector],
      listChannels: () => [
        {
          channelId: 'channel-1',
          channelKey: 'chat-1',
          connectorId: 'connector-1',
          agentId: 'agent-1',
          enabled: true,
        },
        {
          channelId: 'channel-2',
          channelKey: 'chat-2',
          connectorId: 'connector-2',
          agentId: 'agent-1',
          enabled: true,
        },
      ],
      getConnector: (connectorId: string) => [larkConnector, otherConnector]
        .find((connector) => connector.connectorId === connectorId) ?? null,
    }

    expect(listLarkConnectors(configRegistry as any)).toEqual([larkConnector])
    expect(listEnabledLarkChannels(configRegistry as any)).toEqual([
      {
        channelId: 'channel-1',
        channelKey: 'chat-1',
        connectorId: 'connector-1',
        agentId: 'agent-1',
        enabled: true,
      },
    ])
    expect(findLarkChannelByConversationKey(configRegistry as any, 'chat-1')).toMatchObject({
      channelId: 'channel-1',
    })
    expect(findLarkChannelByConversationKey(configRegistry as any, 'missing')).toBeNull()
  })
})
