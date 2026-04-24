import { describe, expect, it } from 'vitest'
import { SessionEventMapper } from './session-event-mapper.js'

describe('SessionEventMapper', () => {
  it('tracks stream message scope, clears it on message_stop, and resets run-local sequence after terminal result', () => {
    const mapper = new SessionEventMapper()

    const start = mapper.mapWorkerOutputEvent({
      kind: 'sdk_stream_event',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 1,
      payload: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          message: { id: 'message-1' },
          content_block: { type: 'text', text: 'hello' },
        },
      },
    })
    const delta = mapper.mapWorkerOutputEvent({
      kind: 'sdk_stream_event',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 2,
      payload: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' world' },
        },
      },
    })
    const stop = mapper.mapWorkerOutputEvent({
      kind: 'sdk_stream_event',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 3,
      payload: {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
    })
    const afterStop = mapper.mapWorkerOutputEvent({
      kind: 'sdk_stream_event',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 4,
      payload: {
        type: 'stream_event',
        parent_tool_use_id: 'tool-1',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', name: 'Read', id: 'tool-1', input: '{"path":"a"}' },
        },
      },
    })

    expect(start).toMatchObject({
      type: 'session.sdk.stream_event',
      sequence: 1,
      event: {
        scope: {
          scopeKey: 'session-1:message:message-1',
          anchorKind: 'message',
          messageId: 'message-1',
        },
        normalized: {
          blockKind: 'text',
          text: 'hello',
        },
      },
    })
    expect(delta).toMatchObject({
      type: 'session.sdk.stream_event',
      sequence: 2,
      event: {
        scope: {
          scopeKey: 'session-1:message:message-1',
          anchorKind: 'message',
          messageId: 'message-1',
        },
        normalized: {
          blockKind: 'text',
          deltaKind: 'text_delta',
          text: ' world',
        },
      },
    })
    expect(stop).toMatchObject({
      type: 'session.sdk.stream_event',
      sequence: 3,
      event: {
        scope: {
          scopeKey: 'session-1:message:message-1',
          anchorKind: 'message',
          messageId: 'message-1',
        },
        event: { type: 'message_stop' },
      },
    })
    expect(afterStop).toMatchObject({
      type: 'session.sdk.stream_event',
      sequence: 4,
      event: {
        scope: {
          scopeKey: 'session-1:tool_use:tool-1',
          anchorKind: 'tool_use',
          anchorId: 'tool-1',
          parentToolUseId: 'tool-1',
        },
        normalized: {
          blockKind: 'tool_use',
          toolName: 'Read',
          toolUseId: 'tool-1',
          partialJson: '{"path":"a"}',
        },
      },
    })

    expect(
      mapper.mapWorkerOutputEvent({
        kind: 'result',
        sessionId: 'session-1',
        runId: 'run-1',
        receivedAt: 5,
        subtype: 'success',
        payload: { ok: true },
      }),
    ).toMatchObject({
      type: 'session.run.completed',
      runId: 'run-1',
      sessionId: 'session-1',
      resultPayload: { ok: true },
    })

    const restarted = mapper.mapWorkerOutputEvent({
      kind: 'sdk_stream_event',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 6,
      payload: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          message: { id: 'message-2' },
          content_block: { type: 'thinking', thinking: 'new run' },
        },
      },
    })

    expect(restarted).toMatchObject({
      type: 'session.sdk.stream_event',
      sequence: 1,
      event: {
        scope: {
          scopeKey: 'session-1:message:message-2',
          messageId: 'message-2',
        },
        normalized: {
          blockKind: 'thinking',
          thinking: 'new run',
          redacted: false,
        },
      },
    })
  })

  it('maps control transaction families and phases onto the public session event types', () => {
    const mapper = new SessionEventMapper()

    const interactive = mapper.mapWorkerOutputEvent({
      kind: 'control_transaction',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 10,
      phase: 'awaiting_user',
      transaction: {
        requestId: 'req-1',
        subtype: 'interrupt',
        family: 'interactive',
        direction: 'sdk_to_host',
        status: 'awaiting_user',
        blocksRun: true,
        openedAt: 10,
        updatedAt: 10,
      },
      payload: { prompt: 'approve?' },
    })
    const control = mapper.mapWorkerOutputEvent({
      kind: 'control_transaction',
      sessionId: 'session-1',
      runId: 'run-1',
      receivedAt: 11,
      phase: 'completed',
      transaction: {
        requestId: 'req-2',
        subtype: 'mcp_status',
        family: 'query',
        direction: 'sdk_to_host',
        status: 'completed',
        blocksRun: false,
        openedAt: 11,
        updatedAt: 11,
      },
    })

    expect(interactive).toMatchObject({
      type: 'session.interactive.awaiting_user',
      sessionId: 'session-1',
      runId: 'run-1',
      payload: { prompt: 'approve?' },
      transaction: {
        requestId: 'req-1',
        family: 'interactive',
      },
    })
    expect(control).toMatchObject({
      type: 'session.control.completed',
      sessionId: 'session-1',
      runId: 'run-1',
      transaction: {
        requestId: 'req-2',
        family: 'query',
      },
    })
  })

  it('maps failure and worker termination into terminal session events', () => {
    const mapper = new SessionEventMapper()

    expect(
      mapper.mapWorkerOutputEvent({
        kind: 'result',
        sessionId: 'session-1',
        runId: 'run-1',
        receivedAt: 20,
        subtype: 'error_during_execution',
        payload: null,
      }),
    ).toEqual({
      type: 'session.run.failed',
      runId: 'run-1',
      sessionId: 'session-1',
      error: 'error_during_execution',
    })

    expect(
      mapper.mapWorkerOutputEvent({
        kind: 'worker_error',
        sessionId: 'session-1',
        runId: 'run-1',
        receivedAt: 21,
        error: 'worker crashed',
      }),
    ).toEqual({
      type: 'session.error',
      runId: 'run-1',
      sessionId: 'session-1',
      error: 'worker crashed',
    })
  })
})
