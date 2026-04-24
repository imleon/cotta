import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WorkerOutputEvent } from '../execution/types.js'
import type {
  ControlTransactionSummary,
  SdkControlEnvelope,
} from './control-types.js'
import type { SessionEvent } from './runtime-event-types.js'
import type { SessionStreamEvent } from './stream-types.js'
import { normalizeSdkEnvelopeMessage } from './transcript-normalizer.js'

export class SessionEventMapper {
  private readonly activeStreamMessageIds = new Map<string, string>()
  private readonly streamSequenceByRunId = new Map<string, number>()
  private eventSequence = 0

  mapWorkerOutputEvent(event: WorkerOutputEvent): SessionEvent | null {
    switch (event.kind) {
      case 'session_state_changed':
        if (event.runId) {
          return {
            type: 'session.run.state_changed',
            runId: event.runId,
            sessionId: event.sessionId,
            state: event.state,
          }
        }
        return {
          type: 'session.state_changed',
          sessionId: event.sessionId,
          state: event.state,
        }

      case 'sdk_message':
        const parsedMessage = normalizeSdkEnvelopeMessage(event.payload)
        return {
          type: 'session.sdk.message',
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          receivedAt: event.receivedAt,
          sequence: this.nextSequence(),
          payload: event.payload as SDKMessage,
          ...(parsedMessage ? { parsed: parsedMessage } : {}),
        }

      case 'sdk_stream_event': {
        const normalized = this.normalizeSdkStreamEvent(event)
        if (!normalized) return null
        return {
          type: 'session.sdk.stream_event',
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          receivedAt: normalized.receivedAt,
          sequence: normalized.sequence,
          event: normalized,
        }
      }

      case 'control_message':
        return {
          type: 'session.control.message',
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          receivedAt: event.receivedAt,
          sequence: this.nextSequence(),
          direction: event.direction,
          message: event.message as SdkControlEnvelope,
          transaction: event.transaction as ControlTransactionSummary,
        }

      case 'control_transaction':
        return {
          type: this.controlTransactionType(event),
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          receivedAt: event.receivedAt,
          sequence: this.nextSequence(),
          transaction: event.transaction as ControlTransactionSummary,
          ...(event.payload !== undefined ? { payload: event.payload } : {}),
        } as SessionEvent

      case 'result':
        this.cleanupRun(event.runId)
        if (event.subtype === 'success' && event.runId) {
          return {
            type: 'session.run.completed',
            runId: event.runId,
            sessionId: event.sessionId,
            resultPayload: event.payload,
          }
        }
        return {
          type: 'session.run.failed',
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          error: event.subtype,
        }

      case 'worker_closed':
        this.cleanupRun(event.runId)
        return {
          type: 'session.worker.closed',
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          receivedAt: event.receivedAt,
          sequence: this.nextSequence(),
        }

      case 'worker_error':
        this.cleanupRun(event.runId)
        return {
          type: 'session.error',
          ...(event.runId ? { runId: event.runId } : {}),
          sessionId: event.sessionId,
          error: event.error,
        }
    }
  }

  private nextSequence(): number {
    this.eventSequence += 1
    return this.eventSequence
  }

  private cleanupRun(runId?: string): void {
    if (!runId) return
    this.streamSequenceByRunId.delete(runId)
    for (const key of this.activeStreamMessageIds.keys()) {
      if (key.startsWith(`run:${runId}:`)) {
        this.activeStreamMessageIds.delete(key)
      }
    }
  }

  private getStreamTrackingKey(input: {
    runId?: string
    sessionId: string
    parentToolUseId?: string | null
  }): string {
    const streamScope = input.parentToolUseId ?? 'root'
    return input.runId
      ? `run:${input.runId}:stream:${streamScope}`
      : `session:${input.sessionId}:stream:${streamScope}`
  }

  private getScopeKey(input: {
    runId?: string
    sessionId: string
    anchorKind: 'message' | 'tool_use' | 'ephemeral'
    anchorId: string
  }): string {
    const prefix = input.runId
      ? `run:${input.runId}`
      : `session:${input.sessionId}`
    return `${prefix}:${input.anchorKind}:${input.anchorId}`
  }

  private controlTransactionType(
    event: Extract<WorkerOutputEvent, { kind: 'control_transaction' }>,
  ): SessionEvent['type'] {
    const familyPrefix = event.transaction.family === 'interactive'
      ? 'session.interactive'
      : 'session.control'
    switch (event.phase) {
      case 'opened':
        return `${familyPrefix}.opened` as SessionEvent['type']
      case 'awaiting_user':
        return `${familyPrefix}.awaiting_user` as SessionEvent['type']
      case 'responded':
        return `${familyPrefix}.responded` as SessionEvent['type']
      case 'completed':
        return `${familyPrefix}.completed` as SessionEvent['type']
      case 'cancel_requested':
        return `${familyPrefix}.cancel_requested` as SessionEvent['type']
      case 'cancelled':
        return `${familyPrefix}.cancelled` as SessionEvent['type']
      case 'failed':
      default:
        return `${familyPrefix}.failed` as SessionEvent['type']
    }
  }

  private normalizeSdkStreamEvent(
    event: Extract<WorkerOutputEvent, { kind: 'sdk_stream_event' }>,
  ): SessionStreamEvent | null {
    const runId = event.runId
    const sessionId = event.sessionId
    const payload = event.payload
    const record = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : null
    if (!record || record.type !== 'stream_event') return null

    const rawEvent = record.event && typeof record.event === 'object'
      ? record.event as Record<string, unknown>
      : null
    const eventType = typeof rawEvent?.type === 'string'
      ? rawEvent.type as SessionStreamEvent['event']['type']
      : null
    if (!rawEvent || !eventType) return null

    const parentToolUseId = typeof record.parent_tool_use_id === 'string'
      ? record.parent_tool_use_id
      : record.parent_tool_use_id === null
        ? null
        : undefined
    const index = typeof rawEvent.index === 'number' ? rawEvent.index : undefined
    const directMessage = rawEvent.message && typeof rawEvent.message === 'object'
      ? rawEvent.message as Record<string, unknown>
      : null
    const directMessageId = typeof directMessage?.id === 'string' ? directMessage.id : undefined

    const trackingKey = this.getStreamTrackingKey({
      runId,
      sessionId,
      parentToolUseId,
    })
    let messageId = directMessageId
    if (messageId) {
      this.activeStreamMessageIds.set(trackingKey, messageId)
    } else {
      messageId = this.activeStreamMessageIds.get(trackingKey)
    }
    if (eventType === 'message_stop') {
      this.activeStreamMessageIds.delete(trackingKey)
    }

    const sequence = runId
      ? (this.streamSequenceByRunId.get(runId) ?? 0) + 1
      : this.nextSequence()
    if (runId) {
      this.streamSequenceByRunId.set(runId, sequence)
    }

    if (!messageId && (eventType === 'message_delta' || eventType === 'message_stop')) {
      return null
    }

    const scope: SessionStreamEvent['scope'] = messageId
      ? {
          scopeKey: this.getScopeKey({
            runId,
            sessionId,
            anchorKind: 'message',
            anchorId: messageId,
          }),
          anchorKind: 'message',
          anchorId: messageId,
          messageId,
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
          ...(index !== undefined ? { index } : {}),
        }
      : typeof parentToolUseId === 'string'
        ? {
            scopeKey: this.getScopeKey({
              runId,
              sessionId,
              anchorKind: 'tool_use',
              anchorId: parentToolUseId,
            }),
            anchorKind: 'tool_use',
            anchorId: parentToolUseId,
            parentToolUseId,
            ...(index !== undefined ? { index } : {}),
          }
        : {
            scopeKey: this.getScopeKey({
              runId,
              sessionId,
              anchorKind: 'ephemeral',
              anchorId: String(sequence),
            }),
            anchorKind: 'ephemeral',
            anchorId: this.getScopeKey({
              runId,
              sessionId,
              anchorKind: 'ephemeral',
              anchorId: String(sequence),
            }),
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
      ...(runId ? { runId } : {}),
      sessionId,
      receivedAt: event.receivedAt,
      sequence,
      scope,
      event: { type: eventType },
      ...(normalized ? { normalized } : {}),
      raw: payload,
    }
  }
}
