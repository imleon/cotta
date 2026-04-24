import { describe, expect, it } from 'vitest'
import { buildAssistantStreamingCard, STREAMING_CARD_ELEMENT_ID } from './card-builder.js'

describe('buildAssistantStreamingCard', () => {
  it('renders a processing placeholder when preview exists but has no visible blocks yet', () => {
    const card = buildAssistantStreamingCard({
      answerText: '',
      preview: {
        scope: {
          scopeKey: 'session-1:message:message-1',
          anchorKind: 'message',
          anchorId: 'message-1',
          messageId: 'message-1',
        },
        phase: 'responding',
        status: 'active',
        active: true,
        blocks: [],
      },
      isFinal: false,
    })

    expect(card).toMatchObject({
      schema: '2.0',
      config: {
        streaming_mode: true,
      },
      body: {
        elements: [
          expect.objectContaining({
            tag: 'markdown',
            content: 'Processing...',
            element_id: STREAMING_CARD_ELEMENT_ID,
          }),
        ],
      },
    })
  })

  it('filters empty finalized thinking blocks from the final preview card', () => {
    const card = buildAssistantStreamingCard({
      answerText: 'Final answer',
      preview: {
        scope: {
          scopeKey: 'session-1:message:message-1',
          anchorKind: 'message',
          anchorId: 'message-1',
          messageId: 'message-1',
        },
        phase: 'complete',
        status: 'finalized',
        active: false,
        blocks: [
          {
            kind: 'thinking',
            index: 0,
            shownText: '',
          },
          {
            kind: 'text',
            index: 1,
            shownText: 'Final answer',
          },
        ],
      },
      footer: {
        stopReason: 'end_turn',
        model: 'claude-sonnet',
      },
      isFinal: true,
    })

    expect((card as any).config.streaming_mode).toBeUndefined()
    expect(JSON.stringify(card)).not.toContain('&nbsp;')
    expect(JSON.stringify(card)).not.toContain('**Thinking**')
    expect(JSON.stringify(card)).toContain('Final answer')
    expect(JSON.stringify(card)).toContain('claude-sonnet')
  })
})
