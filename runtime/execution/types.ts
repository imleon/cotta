import type {
  ControlDirection,
  ControlTransactionSummary,
} from '../protocol/control-types.js'

export type WorkerRef = string

export interface WorkerInputQueryEvent {
  type: 'query'
  runId: string
  text: string
}

export interface WorkerInputControlInterruptEvent {
  type: 'control'
  subtype: 'interrupt'
  requestId?: string
}

export interface WorkerInputControlQueryEvent {
  type: 'control'
  subtype: 'get_context_usage' | 'mcp_status'
  requestId?: string
}

export interface WorkerInputControlRespondEvent {
  type: 'control.respond'
  requestId: string
  kind: 'permission' | 'elicitation'
  response: unknown
}

export interface WorkerInputControlCancelEvent {
  type: 'control.cancel'
  requestId: string
}

export type WorkerInputEvent =
  | WorkerInputQueryEvent
  | WorkerInputControlInterruptEvent
  | WorkerInputControlQueryEvent
  | WorkerInputControlRespondEvent
  | WorkerInputControlCancelEvent

export interface WorkerOutputBase {
  sessionId: string
  runId?: string
  receivedAt: number
}

export interface WorkerOutputSessionStateChanged extends WorkerOutputBase {
  kind: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
  payload: unknown
}

export interface WorkerOutputSdkMessage extends WorkerOutputBase {
  kind: 'sdk_message'
  payload: unknown
}

export interface WorkerOutputSdkStreamEvent extends WorkerOutputBase {
  kind: 'sdk_stream_event'
  payload: unknown
}

export interface WorkerOutputControlTransaction extends WorkerOutputBase {
  kind: 'control_transaction'
  phase: 'opened' | 'awaiting_user' | 'responded' | 'completed' | 'cancel_requested' | 'cancelled' | 'failed'
  transaction: ControlTransactionSummary
  payload?: unknown
}

export interface WorkerOutputControlMessage extends WorkerOutputBase {
  kind: 'control_message'
  direction: ControlDirection
  message: unknown
  transaction: ControlTransactionSummary
}

export interface WorkerOutputResult extends WorkerOutputBase {
  kind: 'result'
  subtype:
    | 'success'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
  payload: unknown
}

export interface WorkerOutputWorkerClosed extends WorkerOutputBase {
  kind: 'worker_closed'
  payload?: unknown
}

export interface WorkerOutputWorkerError extends WorkerOutputBase {
  kind: 'worker_error'
  error: string
  payload?: unknown
}

export type WorkerOutputEvent =
  | WorkerOutputSessionStateChanged
  | WorkerOutputSdkMessage
  | WorkerOutputSdkStreamEvent
  | WorkerOutputControlTransaction
  | WorkerOutputControlMessage
  | WorkerOutputResult
  | WorkerOutputWorkerClosed
  | WorkerOutputWorkerError

export interface WorkerInputSink {
  write(event: WorkerInputEvent): Promise<void>
}

export interface WorkerHandle {
  workerRef: WorkerRef
  sessionId: string
  input: WorkerInputSink
  output: AsyncIterable<WorkerOutputEvent>
  close(): Promise<void>
}
