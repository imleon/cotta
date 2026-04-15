import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WorkerOutputEvent } from '../execution/types.js'

type ResultSubtype = Extract<
  WorkerOutputEvent,
  { kind: 'result' }
>['subtype']

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

  if (message.type === 'system' && message.subtype === 'session_state_changed') {
    return {
      kind: 'session_state_changed',
      sessionId,
      runId,
      receivedAt,
      state: message.state,
      payload: message,
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
      payload: message,
    }
  }

  if (message.type === 'stream_event') {
    return {
      kind: 'sdk_stream_event',
      sessionId,
      runId,
      receivedAt,
      payload: message,
    }
  }

  return {
    kind: 'sdk_message',
    sessionId,
    runId,
    receivedAt,
    payload: message,
  }
}
