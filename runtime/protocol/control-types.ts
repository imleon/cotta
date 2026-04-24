import type { SDKControlRequest, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

export interface PermissionSuggestion {
  action: PermissionUpdate['type'] | 'allow'
  label?: string
  description?: string
  scope?: string
  raw: PermissionUpdate | Record<string, unknown>
}

export type InteractiveSourceKind = 'control' | 'tool' | 'host'

export type InteractiveSource =
  | {
      kind: 'control'
      subtype: string
    }
  | {
      kind: 'tool'
      toolName: string
      toolUseId?: string
    }
  | {
      kind: 'host'
      subtype: string
    }

export interface InteractiveOption {
  value: string
  label: string
}

export interface AskUserQuestionRequestData {
  field: string
  prompt: string
  description?: string
  options: InteractiveOption[]
  defaultValue?: string
  rawQuestion?: Record<string, unknown>
}

export interface AskUserQuestionAnswerContent {
  answers: Record<string, string>
}

export interface InteractionBase {
  id: string
  kind: 'permission' | 'elicitation'
  status: 'pending' | 'resolved' | 'cancelled'
  source: InteractiveSource
  blocksRun?: boolean
}

export interface PermissionInteraction extends InteractionBase {
  kind: 'permission'
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  toolUseId?: string
  agentId?: string
  permissionSuggestions?: PermissionSuggestion[]
}

export interface SdkElicitationInteraction extends InteractionBase {
  kind: 'elicitation'
  toolUseId?: string
  serverName: string
  message: string
  mode?: string
  url?: string
  requestedSchema?: unknown
}

export type PendingInteraction = PermissionInteraction | SdkElicitationInteraction
export type InteractiveTransaction = PendingInteraction

export type ControlFamily = 'interactive' | 'command' | 'query' | 'configuration' | 'integration' | 'lifecycle'
export type ControlDirection = 'sdk_to_host' | 'host_to_sdk'
export type ControlStatus = 'opened' | 'awaiting_handler' | 'awaiting_user' | 'responding' | 'completed' | 'cancel_requested' | 'cancelled' | 'failed'
export type ControlDefaultMode = 'interactive' | 'auto' | 'passthrough' | 'unsupported'

export interface SdkControlRequestEnvelope {
  type: 'control_request'
  request_id: string
  request: {
    subtype: string
    [key: string]: unknown
  }
}

export interface SdkControlResponseSuccessPayload {
  subtype: 'success'
  request_id: string
  response?: Record<string, unknown>
}

export interface SdkControlResponseErrorPayload {
  subtype: 'error'
  request_id: string
  error: string
  pending_permission_requests?: SDKControlRequest[]
}

export interface SdkControlResponseEnvelope {
  type: 'control_response'
  response: SdkControlResponseSuccessPayload | SdkControlResponseErrorPayload
}

export interface SdkControlCancelEnvelope {
  type: 'control_cancel_request'
  request_id: string
}

export type SdkControlEnvelope = SdkControlRequestEnvelope | SdkControlResponseEnvelope | SdkControlCancelEnvelope

export interface ControlDescriptor {
  subtype: string
  family: ControlFamily
  supportedDirections: ControlDirection[]
  requiresResponse: boolean
  cancelSupported: boolean
  blocksRun: boolean
  defaultMode: ControlDefaultMode
  interactionKind?: PendingInteraction['kind']
  interactionType?: 'permission' | 'sdk_elicitation'
}

export interface ControlTransaction {
  requestId: string
  subtype: string
  family: ControlFamily
  direction: ControlDirection
  status: ControlStatus
  openedAt: number
  updatedAt: number
  sessionId?: string
  runId?: string
  request?: SdkControlRequestEnvelope
  response?: SdkControlResponseEnvelope
  cancel?: SdkControlCancelEnvelope
  interaction?: PendingInteraction | null
  payload?: unknown
  error?: string
  blocksRun: boolean
}

export type ControlTransactionSummary = Pick<
  ControlTransaction,
  'requestId' | 'subtype' | 'family' | 'direction' | 'status' | 'sessionId' | 'runId' | 'interaction' | 'payload' | 'blocksRun' | 'openedAt' | 'updatedAt' | 'error'
>

export function summarizeControlTransaction(transaction: ControlTransaction): ControlTransactionSummary {
  return {
    requestId: transaction.requestId,
    subtype: transaction.subtype,
    family: transaction.family,
    direction: transaction.direction,
    status: transaction.status,
    ...(transaction.sessionId ? { sessionId: transaction.sessionId } : {}),
    ...(transaction.runId ? { runId: transaction.runId } : {}),
    ...(transaction.interaction !== undefined ? { interaction: transaction.interaction } : {}),
    ...(transaction.payload !== undefined ? { payload: transaction.payload } : {}),
    blocksRun: transaction.blocksRun,
    openedAt: transaction.openedAt,
    updatedAt: transaction.updatedAt,
    ...(transaction.error ? { error: transaction.error } : {}),
  }
}

export function isControlTransactionInteractive(transaction: ControlTransaction): boolean {
  return transaction.family === 'interactive'
}

export function isControlTransactionBlocking(transaction: Pick<ControlTransaction, 'blocksRun' | 'status'>): boolean {
  return transaction.blocksRun && transaction.status !== 'completed' && transaction.status !== 'cancelled' && transaction.status !== 'failed'
}
