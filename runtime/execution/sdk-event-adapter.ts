import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WorkerOutputEvent } from '../execution/types.js'

type ResultSubtype = Extract<
  WorkerOutputEvent,
  { kind: 'result' }
>['subtype']

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
    console.warn('[sdk-event-adapter] session_id mismatch', {
      expectedSessionId: sessionId,
      actualSessionId: sdkSessionId,
      type: (message as any).type,
      subtype: (message as any).subtype,
    })
  }

  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return {
      kind: 'session_state_changed',
      sessionId,
      runId,
      receivedAt,
      state: message.state,
      payload: sdkSessionId && sdkSessionId !== sessionId
        ? { ...message as any, _host: { expected_session_id: sessionId, actual_session_id: sdkSessionId, session_id_mismatch: true } }
        : message,
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
      payload: sdkSessionId && sdkSessionId !== sessionId
        ? { ...message as any, _host: { expected_session_id: sessionId, actual_session_id: sdkSessionId, session_id_mismatch: true } }
        : message,
    }
  }

  if (message.type === 'stream_event') {
    return {
      kind: 'sdk_stream_event',
      sessionId,
      runId,
      receivedAt,
      payload: sdkSessionId && sdkSessionId !== sessionId
        ? { ...message as any, _host: { expected_session_id: sessionId, actual_session_id: sdkSessionId, session_id_mismatch: true } }
        : message,
    }
  }

  return {
    kind: 'sdk_message',
    sessionId,
    runId,
    receivedAt,
    payload: sdkSessionId && sdkSessionId !== sessionId
      ? { ...message as any, _host: { expected_session_id: sessionId, actual_session_id: sdkSessionId, session_id_mismatch: true } }
      : message,
  }
}
