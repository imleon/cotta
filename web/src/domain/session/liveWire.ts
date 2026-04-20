import type { ControlTransactionSummary, SessionEvent, SessionStreamEvent } from '../../contract/runtime'
import { normalizeSdkEnvelopeMessage } from '../../contract/runtime'

export interface WorkerOutputEventLike {
  kind: string
  sessionId: string
  runId?: string
  receivedAt: number
  payload?: unknown
  state?: unknown
  subtype?: unknown
  error?: unknown
  transaction?: ControlTransactionSummary
  phase?: unknown
}

export interface FooterPatchRequest {
  sessionId: string
  runId: string
  resultPayload: unknown
}

export interface TranslateWorkerOutputResult {
  events: SessionEvent[]
  terminalRunId?: string
  footerPatch?: FooterPatchRequest
}

export function isWorkerOutputEvent(value: unknown): value is WorkerOutputEventLike {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.kind === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.receivedAt === 'number'
}

function toV2SessionStreamEvent(input: {
  payload: unknown
  runId: string
  sessionId: string
  receivedAt: number
  sequence: number
  activeStreamMessageIds: Map<string, string>
}): SessionStreamEvent | null {
  const payload = input.payload && typeof input.payload === 'object'
    ? input.payload as Record<string, unknown>
    : null
  if (!payload || payload.type !== 'stream_event') return null

  const rawEvent = payload.event && typeof payload.event === 'object'
    ? payload.event as Record<string, unknown>
    : null
  const eventType = typeof rawEvent?.type === 'string'
    ? rawEvent.type as SessionStreamEvent['event']['type']
    : null
  if (!rawEvent || !eventType) return null

  const parentToolUseId = typeof payload.parent_tool_use_id === 'string'
    ? payload.parent_tool_use_id
    : payload.parent_tool_use_id === null
      ? null
      : undefined
  const index = typeof rawEvent.index === 'number' ? rawEvent.index : undefined

  const directMessage = rawEvent.message && typeof rawEvent.message === 'object'
    ? rawEvent.message as Record<string, unknown>
    : null
  const directMessageId = typeof directMessage?.id === 'string' ? directMessage.id : undefined

  let messageId = directMessageId
  if (messageId) {
    input.activeStreamMessageIds.set(input.sessionId, messageId)
  } else {
    messageId = input.activeStreamMessageIds.get(input.sessionId)
  }
  if (eventType === 'message_stop') {
    input.activeStreamMessageIds.delete(input.sessionId)
  }

  const scope: SessionStreamEvent['scope'] = messageId
    ? {
        scopeKey: `${input.sessionId}:message:${messageId}`,
        anchorKind: 'message',
        anchorId: messageId,
        messageId,
        ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
        ...(index !== undefined ? { index } : {}),
      }
    : typeof parentToolUseId === 'string'
      ? {
          scopeKey: `${input.sessionId}:tool_use:${parentToolUseId}`,
          anchorKind: 'tool_use',
          anchorId: parentToolUseId,
          parentToolUseId,
          ...(index !== undefined ? { index } : {}),
        }
      : {
          scopeKey: `${input.sessionId}:ephemeral:${input.sequence}`,
          anchorKind: 'ephemeral',
          anchorId: `${input.sessionId}:ephemeral:${input.sequence}`,
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
          ...(index !== undefined ? { index } : {}),
        }

  let normalized: SessionStreamEvent['normalized']
  if (eventType === 'content_block_start') {
    const block = rawEvent.content_block && typeof rawEvent.content_block === 'object'
      ? rawEvent.content_block as Record<string, unknown>
      : null
    if (block?.type === 'text') {
      normalized = { blockKind: 'text', text: typeof block.text === 'string' ? block.text : '' }
    } else if (block?.type === 'thinking') {
      normalized = { blockKind: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', redacted: false }
    } else if (block?.type === 'redacted_thinking') {
      normalized = { blockKind: 'thinking', redacted: true }
    } else if (block?.type === 'tool_use') {
      normalized = {
        blockKind: 'tool_use',
        toolName: typeof block.name === 'string' ? block.name : 'unknown_tool',
        toolUseId: typeof block.id === 'string' ? block.id : undefined,
        partialJson: typeof block.input === 'string' ? block.input : undefined,
      }
    }
  } else if (eventType === 'content_block_delta') {
    const delta = rawEvent.delta && typeof rawEvent.delta === 'object'
      ? rawEvent.delta as Record<string, unknown>
      : null
    const deltaType = typeof delta?.type === 'string' ? delta.type : null
    if (delta && deltaType === 'text_delta') {
      normalized = { blockKind: 'text', deltaKind: 'text_delta', text: typeof delta.text === 'string' ? delta.text : '' }
    } else if (delta && deltaType === 'thinking_delta') {
      normalized = { blockKind: 'thinking', deltaKind: 'thinking_delta', thinking: typeof delta.thinking === 'string' ? delta.thinking : '' }
    } else if (delta && deltaType === 'input_json_delta') {
      normalized = { blockKind: 'tool_use', deltaKind: 'input_json_delta', partialJson: typeof delta.partial_json === 'string' ? delta.partial_json : '' }
    }
  }

  return {
    type: 'session.sdk.stream_event',
    runId: input.runId,
    sessionId: input.sessionId,
    receivedAt: input.receivedAt,
    sequence: input.sequence,
    scope,
    event: { type: eventType },
    ...(normalized ? { normalized } : {}),
    raw: input.payload,
  }
}

export function translateWorkerOutputEvent(input: {
  wire: WorkerOutputEventLike
  sequence: number
  activeStreamMessageIds: Map<string, string>
}): TranslateWorkerOutputResult {
  const { wire } = input
  const sessionId = wire.sessionId
  const runId = typeof wire.runId === 'string' && wire.runId ? wire.runId : null
  const receivedAt = Number.isFinite(wire.receivedAt) ? wire.receivedAt : Date.now()
  const kind = wire.kind

  if (kind === 'session_state_changed') {
    if (!runId) return { events: [] }
    const state = wire.state === 'running' || wire.state === 'requires_action' || wire.state === 'idle'
      ? wire.state
      : 'running'
    return {
      events: [
        ...(state === 'running' ? [{ type: 'session.run.started', runId, sessionId } satisfies SessionEvent] : []),
        { type: 'session.run.state_changed', runId, sessionId, state },
      ],
    }
  }

  if (kind === 'sdk_message') {
    if (!runId) return { events: [] }
    const payload = wire.payload
    const parsed = normalizeSdkEnvelopeMessage(payload)
    return {
      events: [{
        type: 'session.sdk.message',
        runId,
        payload: payload as never,
        ...(parsed ? { parsed } : {}),
        receivedAt,
        sequence: input.sequence,
        sessionId,
      }],
    }
  }

  if (kind === 'sdk_stream_event') {
    if (!runId) return { events: [] }
    const streamEvent = toV2SessionStreamEvent({
      payload: wire.payload,
      runId,
      sessionId,
      receivedAt,
      sequence: input.sequence,
      activeStreamMessageIds: input.activeStreamMessageIds,
    })
    if (!streamEvent) return { events: [] }
    return {
      events: [{
        type: 'session.sdk.stream_event',
        runId,
        event: streamEvent,
        receivedAt,
        sequence: input.sequence,
        sessionId,
      }],
    }
  }

  if (kind === 'control_transaction') {
    const transaction = wire.transaction
    if (!transaction) return { events: [] }
    const effectiveRunId = typeof transaction.runId === 'string' && transaction.runId ? transaction.runId : runId
    const targetSessionId = transaction.sessionId ?? sessionId
    const envelopeBase = {
      ...(effectiveRunId ? { runId: effectiveRunId } : {}),
      sessionId: targetSessionId,
      transaction,
      receivedAt,
      sequence: input.sequence,
      ...(wire.payload !== undefined ? { payload: wire.payload } : {}),
    }
    switch (wire.phase) {
      case 'opened':
        return { events: [{ type: 'session.control.opened', ...envelopeBase }] }
      case 'awaiting_user':
        return { events: [{ type: 'session.control.awaiting_user', ...envelopeBase }] }
      case 'responded':
        return { events: [{ type: 'session.control.responded', ...envelopeBase }] }
      case 'cancel_requested':
        return { events: [{ type: 'session.control.cancel_requested', ...envelopeBase }] }
      case 'cancelled':
        return { events: [{ type: 'session.control.cancelled', ...envelopeBase }] }
      case 'completed':
        return { events: [{ type: 'session.control.completed', ...envelopeBase }] }
      case 'failed':
        return { events: [{ type: 'session.control.failed', ...envelopeBase }] }
      default:
        return { events: [] }
    }
  }

  if (kind === 'result') {
    if (!runId) return { events: [] }
    const payload = wire.payload
    const parsed = normalizeSdkEnvelopeMessage(payload)
    const subtype = typeof wire.subtype === 'string' ? wire.subtype : 'error_during_execution'
    return {
      terminalRunId: runId,
      footerPatch: {
        sessionId,
        runId,
        resultPayload: payload,
      },
      events: [
        {
          type: 'session.sdk.message',
          runId,
          payload: payload as never,
          ...(parsed ? { parsed } : {}),
          receivedAt,
          sequence: input.sequence,
          sessionId,
        },
        subtype === 'success'
          ? { type: 'session.run.completed', runId, sessionId }
          : { type: 'session.run.failed', runId, sessionId, error: `Run failed (${subtype})` },
      ],
    }
  }

  if (kind === 'worker_error') {
    const errorText = typeof wire.error === 'string' ? wire.error : 'Worker error'
    return {
      ...(runId ? { terminalRunId: runId } : {}),
      events: [
        { type: 'session.error', ...(runId ? { runId } : {}), error: errorText },
        ...(runId ? [{ type: 'session.run.failed', runId, sessionId, error: errorText } satisfies SessionEvent] : []),
      ],
    }
  }

  return { events: [] }
}
