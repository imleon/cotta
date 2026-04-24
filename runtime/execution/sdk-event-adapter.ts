import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WorkerOutputEvent } from '../execution/types.js'
import { createLogger } from '../core/logger.js'

type ResultSubtype = Extract<
  WorkerOutputEvent,
  { kind: 'result' }
>['subtype']

const logger = createLogger('sdk-event-adapter')

type HostMismatchMetadata = {
  expected_session_id: string
  actual_session_id: string
  session_id_mismatch: true
}

type SdkMessageWithShape = SDKMessage & {
  type?: unknown
  subtype?: unknown
}

type SdkMessageWithHostMetadata = SDKMessage & {
  _host: HostMismatchMetadata
}

function extractSdkSessionId(message: SDKMessage): string | null {
  const raw = message as unknown as { session_id?: unknown }
  return typeof raw?.session_id === 'string' && raw.session_id.trim() ? raw.session_id : null
}

function isResultSubtype(value: unknown): value is ResultSubtype {
  return value === 'success'
    || value === 'error_during_execution'
    || value === 'error_max_turns'
    || value === 'error_max_budget_usd'
    || value === 'error_max_structured_output_retries'
}

function withHostSessionMismatch(
  message: SDKMessage,
  sessionId: string,
  sdkSessionId: string | null,
): SDKMessage | SdkMessageWithHostMetadata {
  if (!sdkSessionId || sdkSessionId === sessionId) return message
  return {
    ...message,
    _host: {
      expected_session_id: sessionId,
      actual_session_id: sdkSessionId,
      session_id_mismatch: true,
    },
  }
}

export function adaptSdkMessage(
  message: SDKMessage,
  sessionId: string,
  runId?: string,
): WorkerOutputEvent {
  const receivedAt = Date.now()
  const sdkSessionId = extractSdkSessionId(message)
  if (sdkSessionId && sdkSessionId !== sessionId) {
    // Invariant check: under normal conditions, SDK output session_id should match
    // the worker's expected sessionId. We only log here; do not change behavior.
    const shapedMessage = message as SdkMessageWithShape
    logger.warn('session-id-mismatch', {
      expectedSessionId: sessionId,
      actualSessionId: sdkSessionId,
      type: shapedMessage.type,
      subtype: shapedMessage.subtype,
    })
  }

  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return {
      kind: 'session_state_changed',
      sessionId,
      runId,
      receivedAt,
      state: message.state,
      payload: withHostSessionMismatch(message, sessionId, sdkSessionId),
    }
  }

  if (message.type === 'result') {
    const subtype = isResultSubtype(message.subtype)
      ? message.subtype
      : 'error_during_execution'

    return {
      kind: 'result',
      sessionId,
      runId,
      receivedAt,
      subtype,
      payload: withHostSessionMismatch(message, sessionId, sdkSessionId),
    }
  }

  if (message.type === 'stream_event') {
    return {
      kind: 'sdk_stream_event',
      sessionId,
      runId,
      receivedAt,
      payload: withHostSessionMismatch(message, sessionId, sdkSessionId),
    }
  }

  return {
    kind: 'sdk_message',
    sessionId,
    runId,
    receivedAt,
    payload: withHostSessionMismatch(message, sessionId, sdkSessionId),
  }
}
