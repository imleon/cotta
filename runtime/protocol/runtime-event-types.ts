import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ControlDirection, ControlTransactionSummary, PendingInteraction, SdkControlEnvelope } from './control-types.js'
import type { SessionLifecycleState, SessionMessage, SessionRunState } from './session-contract-types.js'
import type { SessionStreamEvent } from './stream-types.js'

export interface RunStateSnapshot {
  status: SessionLifecycleState
  sessionId?: string
  currentInteraction?: PendingInteraction | null
}

export interface RuntimeEnvelopeBase {
  sessionId?: string
  receivedAt: number
  sequence: number
}

export type SdkRawLogKind = 'sdk_message' | 'control_request' | 'control_response' | 'control_cancel_request'
export type SdkRawLogDirection = 'sdk_to_host' | 'host_to_sdk' | 'sdk_outbound'

export interface SdkRawLogEvent extends RuntimeEnvelopeBase {
  source: 'sdk-raw'
  kind: SdkRawLogKind
  direction: SdkRawLogDirection
  requestId?: string
  subtype?: string
  message: unknown
}

export interface SessionSdkRawLogEntry {
  cursor: number
  runId: string
  loggedAt: number
  sessionId: string
  event: SdkRawLogEvent
}

export interface SessionSdkRawLogPage {
  items: SessionSdkRawLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

export interface SessionPersistentLogEntry {
  cursor: number
  loggedAt: number | null
  line: string
  tags?: string[]
}

export interface SessionPersistentLogPage {
  items: SessionPersistentLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

export type SessionEvent =
  | ({ type: 'session.state_changed'; state: 'idle' | 'running' | 'requires_action' } & Pick<RuntimeEnvelopeBase, 'sessionId'>)
  | { type: 'session.run.queued'; runId: string; sessionId?: string }
  | { type: 'session.run.started'; runId: string; sessionId?: string }
  | { type: 'session.run.state_changed'; runId: string; state: SessionRunState; sessionId?: string }
  | { type: 'session.run.completed'; runId: string; sessionId?: string; exitCode?: number | null; error?: string; resultPayload?: unknown }
  | { type: 'session.run.failed'; runId?: string; sessionId?: string; error: string }
  | { type: 'session.run.cancelled'; runId: string; sessionId?: string }
  | ({ type: 'session.sdk.message'; runId?: string; payload: SDKMessage; parsed?: SessionMessage } & RuntimeEnvelopeBase)
  | ({ type: 'session.sdk.stream_event'; runId?: string; event: SessionStreamEvent } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.message'; runId?: string; direction: ControlDirection; message: SdkControlEnvelope; transaction: ControlTransactionSummary } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.opened'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.awaiting_user'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.responded'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.completed'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.cancel_requested'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.cancelled'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.failed'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.opened'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.awaiting_user'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.responded'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.completed'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.cancel_requested'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.cancelled'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.failed'; runId?: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.worker.closed'; runId?: string } & RuntimeEnvelopeBase)
  | { type: 'session.error'; runId?: string; sessionId?: string; error: string }

export interface WsNoticeEvent {
  type: 'ws.notice'
  message: string
}

export type ExternalAdminWsEvent = SessionEvent | WsNoticeEvent

export type LaneKind = 'history' | 'user' | 'live' | 'session' | 'drop'
export type LiveLaneKind = 'user' | 'stream_event' | 'assistant' | 'system' | 'result' | 'tool_progress' | 'tool_use_summary' | 'prompt_suggestion'

export type SdkLaneClassification = {
  lane: Exclude<LaneKind, 'history'>
  liveKind?: LiveLaneKind
}

export function classifySdkMessageLane(message: SDKMessage): SdkLaneClassification {
  switch (message.type) {
    case 'user': {
      const replay = 'isReplay' in message && message.isReplay === true
      if (replay) return { lane: 'drop' }
      const synthetic = message.isSynthetic === true
      const parentToolUseId = message.parent_tool_use_id
      const hasToolUseResult = message.tool_use_result != null
      if (!synthetic && parentToolUseId == null && !hasToolUseResult) {
        return { lane: 'user' }
      }
      return { lane: 'live', liveKind: 'user' }
    }
    case 'stream_event':
      return { lane: 'live', liveKind: 'stream_event' }
    case 'assistant':
      return { lane: 'live', liveKind: 'assistant' }
    case 'system':
      return { lane: 'live', liveKind: 'system' }
    case 'result':
      return { lane: 'live', liveKind: 'result' }
    case 'tool_progress':
      return { lane: 'live', liveKind: 'tool_progress' }
    case 'tool_use_summary':
      return { lane: 'live', liveKind: 'tool_use_summary' }
    case 'prompt_suggestion':
      return { lane: 'live', liveKind: 'prompt_suggestion' }
    case 'auth_status':
    case 'rate_limit_event':
      return { lane: 'session' }
    default:
      return { lane: 'drop' }
  }
}
