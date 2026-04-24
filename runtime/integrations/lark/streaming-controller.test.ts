import { describe, expect, it, vi } from 'vitest'
import { LarkStreamingController } from './streaming-controller.js'

function createControllerHarness() {
  const buildCard = vi.fn((params: { answerText: string; isFinal?: boolean }) => ({
    schema: '2.0',
    body: {
      elements: [{ tag: 'markdown', content: params.answerText || 'Processing...' }],
    },
    meta: {
      isFinal: Boolean(params.isFinal),
    },
  }))
  const appendLog = vi.fn().mockResolvedValue(undefined)
  const createCardKitMessage = vi.fn().mockResolvedValue({
    delivered: true,
    cardId: 'card-1',
    messageId: 'message-1',
  })
  const updateCardKitPreview = vi.fn().mockResolvedValue({ delivered: true })
  const finalizeCardKit = vi.fn().mockResolvedValue({ delivered: true })

  const controller = new LarkStreamingController({
    runId: 'run-1',
    conversationKey: 'chat-1',
    sessionId: 'session-1',
    buildCard,
    buildFinalCard: vi.fn().mockResolvedValue({
      schema: '2.0',
      body: {
        elements: [{ tag: 'markdown', content: 'final-card' }],
      },
    }),
    createCardKitMessage,
    updateCardKitPreview,
    finalizeCardKit,
    appendLog,
    getFooterMetrics: vi.fn().mockResolvedValue({
      stopReason: 'end_turn',
      model: 'claude-sonnet',
    }),
  })

  return {
    controller,
    buildCard,
    appendLog,
    createCardKitMessage,
    updateCardKitPreview,
    finalizeCardKit,
  }
}

describe('LarkStreamingController', () => {
  it('creates the initial card with a processing placeholder for message_start events', async () => {
    const harness = createControllerHarness()

    await harness.controller.onStreamEvent({
      type: 'session.sdk.stream_event',
      runId: 'run-1',
      sessionId: 'session-1',
      receivedAt: 1,
      sequence: 1,
      scope: {
        scopeKey: 'session-1:message:message-1',
        anchorKind: 'message',
        anchorId: 'message-1',
        messageId: 'message-1',
      },
      event: { type: 'message_start' },
    })

    expect(harness.createCardKitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          elements: [{ tag: 'markdown', content: 'Processing...' }],
        },
      }),
    )
  })

  it('finalizes by updating the last card content before closing streaming mode', async () => {
    const harness = createControllerHarness()

    await harness.controller.onStreamEvent({
      type: 'session.sdk.stream_event',
      runId: 'run-1',
      sessionId: 'session-1',
      receivedAt: 1,
      sequence: 1,
      scope: {
        scopeKey: 'session-1:message:message-1',
        anchorKind: 'message',
        anchorId: 'message-1',
        messageId: 'message-1',
      },
      event: { type: 'message_start' },
    })
    await harness.controller.onMaterializedText('hello')
    harness.controller.markFullyComplete()

    const delivered = await harness.controller.onIdle()

    expect(delivered).toBe(true)
    expect(harness.finalizeCardKit).toHaveBeenCalledWith(
      'card-1',
      3,
      2,
      expect.objectContaining({
        body: {
          elements: [{ tag: 'markdown', content: 'final-card' }],
        },
      }),
    )
    expect(harness.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'message.delivered',
        payloadSummary: 'streaming-finalize',
      }),
    )
  })
})
