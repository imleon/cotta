import type { SDKControlRequest, SDKMessage, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type {
  TranscriptAssistantUsage,
  TranscriptBlock,
  TranscriptMessage,
  TranscriptSemanticKind,
} from './transcript-normalizer.js'

export interface StreamEventEnvelope {
  runId: string
  sessionId?: string
  receivedAt: number
  sequence: number
}

export type StreamEventAnchorKind = 'message' | 'tool_use' | 'ephemeral'

export interface StreamEventScope {
  scopeKey: string
  anchorKind: StreamEventAnchorKind
  anchorId: string
  messageId?: string
  parentToolUseId?: string | null
  index?: number
}

export type StreamEventType =
  | 'message_start'
  | 'message_delta'
  | 'message_stop'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'

export type StreamBlockKind = 'text' | 'thinking' | 'tool_use'
export type StreamDeltaKind = 'text_delta' | 'thinking_delta' | 'input_json_delta'

export interface StreamEventNormalized {
  blockKind?: StreamBlockKind
  deltaKind?: StreamDeltaKind
  text?: string
  thinking?: string
  partialJson?: string
  toolName?: string
  toolUseId?: string
  redacted?: boolean
}

export interface SessionStreamEvent {
  type: 'session.sdk.stream_event'
  runId: string
  sessionId?: string
  receivedAt: number
  sequence: number
  scope: StreamEventScope
  event: {
    type: StreamEventType
  }
  normalized?: StreamEventNormalized
  raw?: unknown
}

export type StreamPreviewPhase = 'idle' | 'thinking' | 'responding' | 'tool-input' | 'complete'

export interface StreamPreviewTextBlock {
  kind: 'text'
  index: number
  text: string
}

export interface StreamPreviewThinkingBlock {
  kind: 'thinking'
  index: number
  text: string
  redacted?: boolean
}

export interface StreamPreviewToolUseBlock {
  kind: 'tool_use'
  index: number
  name: string
  toolUseId?: string
  inputText: string
}

export type StreamPreviewBlock =
  | StreamPreviewTextBlock
  | StreamPreviewThinkingBlock
  | StreamPreviewToolUseBlock

export type StreamPreviewStatus = 'active' | 'awaiting-materialization' | 'finalized'

export interface StreamPreviewState {
  scope: StreamEventScope
  phase: StreamPreviewPhase
  status: StreamPreviewStatus
  active: boolean
  blocks: StreamPreviewBlock[]
  receivedAt?: number
  sequence?: number
}

export interface StreamAnimationCursorBlock {
  kind: StreamPreviewBlock['kind']
  index: number
  visibleChars: number
}

export interface StreamAnimationCursor {
  scope: StreamEventScope
  phase: StreamPreviewPhase
  status: StreamPreviewStatus
  active: boolean
  blocks: StreamAnimationCursorBlock[]
}

export interface StreamRenderedPreviewTextBlock {
  kind: 'text'
  index: number
  shownText: string
}

export interface StreamRenderedPreviewThinkingBlock {
  kind: 'thinking'
  index: number
  shownText: string
  redacted?: boolean
}

export interface StreamRenderedPreviewToolUseBlock {
  kind: 'tool_use'
  index: number
  name: string
  toolUseId?: string
  shownInput: string
}

export type StreamRenderedPreviewBlock =
  | StreamRenderedPreviewTextBlock
  | StreamRenderedPreviewThinkingBlock
  | StreamRenderedPreviewToolUseBlock

export interface StreamRenderedPreviewState {
  scope: StreamEventScope
  phase: StreamPreviewPhase
  status: StreamPreviewStatus
  active: boolean
  blocks: StreamRenderedPreviewBlock[]
}

export type SessionRunState = 'idle' | 'queued' | 'running' | 'requires_action' | 'completed' | 'failed' | 'cancelled'
export type SessionLifecycleState = SessionRunState

export type SessionMessageBlock = TranscriptBlock
export type SessionMessage = TranscriptMessage

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
}

export interface TranscriptLinkage {
  messageId: string | null
  toolUseIds: string[]
  toolResultForIds: string[]
}

export interface TranscriptAtom {
  id: string
  source: 'history' | 'live'
  order: {
    timestamp: number
    sequence?: number
    sourceIndex: number
  }
  message: SessionMessage
  role: SessionMessage['role']
  semanticKind: TranscriptSemanticKind
  linkage: TranscriptLinkage
  assistant: {
    stopReason?: string | null
    model?: string | null
    usage?: TranscriptAssistantUsage | null
  }
  meta: {
    optimistic?: boolean
    localId?: string
    raw?: unknown
  }
}

export interface DebugAtomMeta {
  atomId: string
  uuid: string | null
  responseId?: string | null
  role: SessionMessage['role']
  semanticKind: TranscriptSemanticKind
  order: {
    timestamp: number
    sequence?: number
    sourceIndex: number
  }
  source: TranscriptAtom['source']
  linkage: TranscriptLinkage
  assistant: TranscriptAtom['assistant']
}

export interface DisplayFragmentText {
  type: 'text'
  text: string
  debug?: DebugAtomMeta
}

export interface DisplayFragmentThinking {
  type: 'thinking'
  text?: string
  redacted?: boolean
  defaultHidden: boolean
  debug?: DebugAtomMeta
}

export interface DisplayFragmentToolUse {
  type: 'tool_use'
  name: string
  toolUseId?: string
  input?: unknown
  grouped?: boolean
  debug?: DebugAtomMeta
}

export interface ToolResultDisplayMeta {
  previewText: string
  lineCount: number
  charCount: number
  defaultExpanded: boolean
}

export interface DisplayFragmentToolResult {
  type: 'tool_result'
  toolUseId?: string
  output?: unknown
  attachedToParent?: boolean
  defaultCollapsed?: boolean
  display?: ToolResultDisplayMeta
  debug?: DebugAtomMeta
}

export interface DisplayFragmentSummary {
  type: 'summary'
  text: string
  defaultCollapsed: boolean
  debug?: DebugAtomMeta
}

export type DisplayFragment =
  | DisplayFragmentText
  | DisplayFragmentThinking
  | DisplayFragmentToolUse
  | DisplayFragmentToolResult
  | DisplayFragmentSummary

export interface DisplayAssistantFooter {
  stopReason?: string | null
  model?: string | null
  usage?: TranscriptAssistantUsage | null
  executionDurationMs?: number | null
  completedAt?: number | null
  deltaMs?: number | null
}

export interface UserDisplayItem {
  kind: 'user'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  message: SessionMessage
  displayKind?: 'default' | 'command_input' | 'command_output'
  debug?: DebugAtomMeta
}

export interface AssistantDisplayItem {
  kind: 'assistant'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  messages: SessionMessage[]
  anchorMessage: SessionMessage
  fragments: DisplayFragment[]
  hiddenAtomIds?: string[]
  footer?: DisplayAssistantFooter
  overlays?: TimelineOverlayItem[]
}

export interface GroupedToolUseEntry {
  toolUseId?: string
  name: string
  input?: unknown
  result?: unknown
  resultDisplay?: ToolResultDisplayMeta
  debug?: DebugAtomMeta
}

export type DisplayLifecycleStatus = 'streaming' | 'completed' | 'errored'

export interface GroupedToolUseDisplayItem {
  kind: 'grouped_tool_use'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  toolName: string
  toolUses: GroupedToolUseEntry[]
  anchorMessage: SessionMessage
  footer?: DisplayAssistantFooter
  status: DisplayLifecycleStatus
  overlays?: TimelineOverlayItem[]
}

export interface CollapsedToolBatchSummary {
  readCount: number
  searchCount: number
  listCount: number
  bashCount: number
  latestHint?: string
}

export interface CollapsedToolBatchDisplayItem {
  kind: 'collapsed_tool_batch'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  batchKind: 'read_search' | 'meta_ops'
  summary: CollapsedToolBatchSummary
  items: Array<AssistantDisplayItem | GroupedToolUseDisplayItem>
  anchorMessage: SessionMessage
  footer?: DisplayAssistantFooter
  status: DisplayLifecycleStatus
  overlays?: TimelineOverlayItem[]
}

export interface SummaryDisplayItem {
  kind: 'summary'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  content: string
  summaryType: 'post_turn' | 'compact' | 'synthetic'
  defaultCollapsed: boolean
  anchorMessage: SessionMessage
}

export type TimelineOverlayKind = 'streaming_text' | 'streaming_thinking' | 'streaming_tool_use' | 'streaming_progress'

export interface TimelineOverlayAnchor {
  scopeKey: string
  anchorKind: StreamEventAnchorKind
  anchorId: string
  messageId?: string
  parentToolUseId?: string | null
}

export interface TimelineLivePreviewItem {
  kind: 'live_preview'
  layer: 'overlay'
  overlayKind: TimelineOverlayKind
  anchor: TimelineOverlayAnchor
  id: string
  key: string
  timestamp: number
  preview: StreamRenderedPreviewState
}

export interface HiddenDebugAtomItem {
  kind: 'hidden_debug_atom'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  atom: TranscriptAtom
  reason: 'meta' | 'summary' | 'redacted_thinking'
}

export type TimelineRenderableItem = DisplayItem | TimelineLivePreviewItem | HiddenDebugAtomItem
export type TimelineOverlayItem = TimelineLivePreviewItem

export interface TranscriptLookup {
  toolUseAtomsByToolUseId: Map<string, TranscriptAtom>
  toolResultAtomsByToolUseId: Map<string, TranscriptAtom>
  atomsByMessageId: Map<string, TranscriptAtom[]>
  siblingToolUseIdsByToolUseId: Map<string, string[]>
  resolvedToolUseIds: Set<string>
}

export type DisplayItem =
  | UserDisplayItem
  | AssistantDisplayItem
  | GroupedToolUseDisplayItem
  | CollapsedToolBatchDisplayItem
  | SummaryDisplayItem


export type ChannelType = 'web' | 'lark' | 'discord'

export interface ChannelConversationRef {
  channel: ChannelType
  conversationKey: string
  userKey?: string
}

export interface ChannelInboundMessage extends ChannelConversationRef {
  text: string
  sessionId?: string
  platformMessageId?: string
  replyToMessageId?: string
  chatType?: 'p2p' | 'group'
  senderOpenId?: string
}

export interface ChannelOutboundMessage extends ChannelConversationRef {
  runId: string
  sessionId?: string
  content: string
  replyToMessageId?: string
}

export interface SessionBinding extends ChannelConversationRef {
  sessionId: string
  updatedAt: number
  chatType?: 'p2p' | 'group'
  lastRunId?: string
  activeInteractionId?: string
  lastInboundPlatformMessageId?: string
}

export interface ActiveRunSummary {
  runId: string
  state: SessionRunState
  sessionId?: string
}

export interface SessionBindingStatus {
  ref: ChannelConversationRef
  binding: SessionBinding | null
  session: SessionSummary | null
  activeRun: ActiveRunSummary | null
}

export type LarkDeliveryMode = 'cardkit' | 'interactive' | 'text'

export type LarkStreamingPhase = 'idle' | 'streaming' | 'completed' | 'failed'

export interface LarkStreamingState {
  runId: string
  conversationKey: string
  sessionId?: string
  mode: LarkDeliveryMode
  phase: LarkStreamingPhase
  accumulatedText: string
  sequence: number
  messageId?: string
  cardId?: string
}

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

export const DEFAULT_CONTROL_DESCRIPTOR: ControlDescriptor = {
  subtype: 'unknown',
  family: 'integration',
  supportedDirections: ['sdk_to_host', 'host_to_sdk'],
  requiresResponse: true,
  cancelSupported: false,
  blocksRun: false,
  defaultMode: 'unsupported',
}

export const CONTROL_DESCRIPTOR_REGISTRY: Record<string, ControlDescriptor> = {
  can_use_tool: {
    subtype: 'can_use_tool',
    family: 'interactive',
    supportedDirections: ['sdk_to_host'],
    requiresResponse: true,
    cancelSupported: true,
    blocksRun: true,
    defaultMode: 'interactive',
    interactionKind: 'permission',
    interactionType: 'permission',
  },
  elicitation: {
    subtype: 'elicitation',
    family: 'interactive',
    supportedDirections: ['sdk_to_host'],
    requiresResponse: true,
    cancelSupported: true,
    blocksRun: true,
    defaultMode: 'interactive',
    interactionKind: 'elicitation',
    interactionType: 'sdk_elicitation',
  },
  interrupt: {
    subtype: 'interrupt',
    family: 'command',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  initialize: {
    subtype: 'initialize',
    family: 'lifecycle',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'auto',
  },
  set_permission_mode: {
    subtype: 'set_permission_mode',
    family: 'configuration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  set_model: {
    subtype: 'set_model',
    family: 'configuration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  set_max_thinking_tokens: {
    subtype: 'set_max_thinking_tokens',
    family: 'configuration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  mcp_status: {
    subtype: 'mcp_status',
    family: 'query',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  get_context_usage: {
    subtype: 'get_context_usage',
    family: 'query',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  hook_callback: {
    subtype: 'hook_callback',
    family: 'integration',
    supportedDirections: ['sdk_to_host'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  mcp_message: {
    subtype: 'mcp_message',
    family: 'integration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  rewind_files: {
    subtype: 'rewind_files',
    family: 'command',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  cancel_async_message: {
    subtype: 'cancel_async_message',
    family: 'command',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  seed_read_state: {
    subtype: 'seed_read_state',
    family: 'lifecycle',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  mcp_set_servers: {
    subtype: 'mcp_set_servers',
    family: 'integration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  reload_plugins: {
    subtype: 'reload_plugins',
    family: 'integration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  mcp_reconnect: {
    subtype: 'mcp_reconnect',
    family: 'integration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  mcp_toggle: {
    subtype: 'mcp_toggle',
    family: 'integration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  stop_task: {
    subtype: 'stop_task',
    family: 'command',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  apply_flag_settings: {
    subtype: 'apply_flag_settings',
    family: 'configuration',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
  get_settings: {
    subtype: 'get_settings',
    family: 'query',
    supportedDirections: ['sdk_to_host', 'host_to_sdk'],
    requiresResponse: true,
    cancelSupported: false,
    blocksRun: false,
    defaultMode: 'passthrough',
  },
}

export function getControlDescriptor(subtype: string | undefined | null): ControlDescriptor {
  if (!subtype) return DEFAULT_CONTROL_DESCRIPTOR
  return CONTROL_DESCRIPTOR_REGISTRY[subtype] ?? {
    ...DEFAULT_CONTROL_DESCRIPTOR,
    subtype,
  }
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
  'requestId' | 'subtype' | 'family' | 'direction' | 'status' | 'sessionId' | 'runId' | 'interaction' | 'blocksRun' | 'openedAt' | 'updatedAt' | 'error'
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
  message: SDKMessage | SdkControlEnvelope
}

export type SdkTransportDirection = 'inbound' | 'outbound'
export type ChannelLogDirection = 'inbound' | 'outbound' | 'internal'
export type SdkTransportEventName =
  | 'query.start'
  | 'query.cancel'
  | 'query.completed'
  | 'query.failed'
  | 'query.cancelled'
  | 'message'
  | 'control.request'
  | 'control.response'
  | 'control.cancel_request'
  | 'control.request.permission'
  | 'control.response.permission'
  | 'control.request.elicitation'
  | 'control.response.elicitation'

export interface SdkTransportEvent extends RuntimeEnvelopeBase {
  source: 'sdk-transport'
  direction: SdkTransportDirection
  eventName: SdkTransportEventName
  sdkType?: string
  sdkSubtype?: string
  requestId?: string
  toolUseId?: string
  payloadSummary?: string
  payload?: unknown
}

export interface SessionTransportLogEntry {
  cursor: number
  runId: string
  event: SdkTransportEvent & { sessionId: string }
}

export interface SessionTransportLogPage {
  items: SessionTransportLogEntry[]
  hasMore: boolean
  nextCursor: number | null
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
}

export interface SessionPersistentLogPage {
  items: SessionPersistentLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

export interface SessionRuntimeLogEntry {
  cursor: number
  runId: string
  loggedAt: number
  sessionId: string
  event: RunnerRuntimeEvent
}

export interface SessionRuntimeLogPage {
  items: SessionRuntimeLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

export interface ChannelLogEvent {
  source: 'channel'
  channel: ChannelType
  direction: ChannelLogDirection
  eventName: string
  conversationKey?: string
  platformMessageId?: string
  payloadSummary?: string
  payload?: unknown
  rawPayload?: unknown
}

export interface SessionChannelLogEntry {
  cursor: number
  runId?: string
  loggedAt: number
  sessionId: string
  event: ChannelLogEvent
}

export interface SessionChannelLogPage {
  items: SessionChannelLogEntry[]
  hasMore: boolean
  nextCursor: number | null
}

export type RunnerAgentInput = {
  prompt: string
  sessionId?: string
  workspacePath: string
  systemPrompt?: string
  model?: string
}

export type RunnerCommand =
  | { type: 'run.start'; input: RunnerAgentInput }
  | { type: 'run.cancel' }
  | { type: 'interactive.respond'; requestId: string; response: { kind: 'permission'; decision: 'approve' | 'deny'; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> } | { kind: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } }
  | { type: 'control.cancel'; requestId: string }
  | { type: 'control.request'; requestId: string; request: { subtype: 'interrupt' } | { subtype: 'get_context_usage' } | { subtype: 'mcp_status' } }

export type RunnerRuntimeEvent =
  | { type: 'run.started'; sessionId?: string }
  | { type: 'run.state_changed'; state: SessionRunState; sessionId?: string }
  | { type: 'run.completed'; messageCount: number; sessionId?: string }
  | { type: 'run.failed'; error: string; stack?: string; sessionId?: string }
  | { type: 'run.cancelled'; sessionId?: string }
  | ({ type: 'sdk.message'; payload: SDKMessage; parsed?: SessionMessage } & RuntimeEnvelopeBase)
  | ({ type: 'sdk.stream_event'; event: SessionStreamEvent } & RuntimeEnvelopeBase)
  | ({ type: 'control.message'; direction: ControlDirection; message: SdkControlEnvelope; transaction: ControlTransactionSummary } & RuntimeEnvelopeBase)
  | ({ type: 'control.opened'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'control.awaiting_user'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'control.responded'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'control.completed'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'control.cancel_requested'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'control.cancelled'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'control.failed'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'interactive.opened'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'interactive.awaiting_user'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'interactive.responded'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'interactive.completed'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'interactive.cancelled'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'interactive.failed'; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | { type: 'sdk.transport'; event: SdkTransportEvent }
  | { type: 'sdk.raw'; event: SdkRawLogEvent }

export type SessionEvent =
  | { type: 'session.run.queued'; runId: string; sessionId?: string }
  | { type: 'session.run.started'; runId: string; sessionId?: string }
  | { type: 'session.run.state_changed'; runId: string; state: SessionRunState; sessionId?: string }
  | { type: 'session.run.completed'; runId: string; sessionId?: string; exitCode?: number | null; error?: string }
  | { type: 'session.run.failed'; runId?: string; sessionId?: string; error: string }
  | { type: 'session.run.cancelled'; runId: string; sessionId?: string }
  | ({ type: 'session.sdk.message'; runId: string; payload: SDKMessage; parsed?: SessionMessage } & RuntimeEnvelopeBase)
  | ({ type: 'session.sdk.stream_event'; runId: string; event: SessionStreamEvent } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.message'; runId: string; direction: ControlDirection; message: SdkControlEnvelope; transaction: ControlTransactionSummary } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.opened'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.awaiting_user'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.responded'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.completed'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.cancel_requested'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.cancelled'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.control.failed'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.opened'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.awaiting_user'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.responded'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.completed'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.cancelled'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.interactive.failed'; runId: string; transaction: ControlTransactionSummary; payload?: unknown } & RuntimeEnvelopeBase)
  | { type: 'session.sdk.transport'; runId: string; event: SdkTransportEvent }
  | { type: 'session.error'; runId?: string; error: string }

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

export type SdkMessageLayer = 'business-message' | 'run-state' | 'debug-observability' | 'live-preview'

export function getSdkMessageLayer(message: SDKMessage): SdkMessageLayer {
  switch (message.type) {
    case 'assistant':
    case 'user':
      return 'business-message'
    case 'stream_event':
      return 'live-preview'
    case 'result':
    case 'tool_progress':
    case 'tool_use_summary':
      return 'run-state'
    case 'system':
      switch (message.subtype) {
        case 'session_state_changed':
        case 'status':
        case 'task_started':
        case 'task_progress':
        case 'task_notification':
          return 'run-state'
        default:
          return 'debug-observability'
      }
    case 'auth_status':
    case 'prompt_suggestion':
    case 'rate_limit_event':
      return 'debug-observability'
    default:
      return 'debug-observability'
  }
}

export function isBusinessSdkMessage(message: SDKMessage): boolean {
  return getSdkMessageLayer(message) === 'business-message'
}

export function isLivePreviewSdkMessage(message: SDKMessage): boolean {
  return getSdkMessageLayer(message) === 'live-preview'
}

export type StaticMetadataNodeKind = 'group' | 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'union' | 'unknown'
export type StaticMetadataNodeStatus = 'resolved' | 'unavailable' | 'session-required'

export interface StaticMetadataTreeNode {
  key: string
  path: string
  label: string
  kind: StaticMetadataNodeKind
  status: StaticMetadataNodeStatus
  description?: string
  source?: string
  value?: unknown
  requiresSession?: boolean
  children?: StaticMetadataTreeNode[]
  meta?: Record<string, unknown>
}

export interface StaticMetadataSnapshot {
  generatedAt: number
  groups: StaticMetadataTreeNode[]
}
