import type { SDKMessage, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type {
  TranscriptAssistantUsage,
  TranscriptBlock,
  TranscriptLivePreviewState,
  TranscriptMessage,
  TranscriptSemanticKind,
} from './transcript-normalizer.js'

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

export interface DisplayFragmentText {
  type: 'text'
  text: string
}

export interface DisplayFragmentThinking {
  type: 'thinking'
  text?: string
  redacted?: boolean
  defaultHidden: boolean
}

export interface DisplayFragmentToolUse {
  type: 'tool_use'
  name: string
  toolUseId?: string
  input?: unknown
  grouped?: boolean
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
}

export interface DisplayFragmentSummary {
  type: 'summary'
  text: string
  defaultCollapsed: boolean
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
}

export interface UserDisplayItem {
  kind: 'user'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  message: SessionMessage
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
  footer?: DisplayAssistantFooter
  overlays?: TimelineOverlayItem[]
}

export interface GroupedToolUseEntry {
  toolUseId?: string
  name: string
  input?: unknown
  result?: unknown
  resultDisplay?: ToolResultDisplayMeta
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
  preview: TranscriptLivePreviewState
}

export interface LivePreviewMapEntry {
  scopeKey: string
  preview: TranscriptLivePreviewState
}

export type TimelineRenderableItem = DisplayItem | TimelineLivePreviewItem
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
  lastRunId?: string
  activeInteractionId?: string
  lastInboundPlatformMessageId?: string
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
  lastMessageCursor?: number
  finalizedAt?: number
}

export interface PermissionSuggestion {
  action: PermissionUpdate['type'] | 'allow'
  label?: string
  description?: string
  scope?: string
  raw: PermissionUpdate | Record<string, unknown>
}

export interface PendingInteractionBase {
  id: string
  kind: 'permission' | 'elicitation'
  status: 'pending' | 'resolved' | 'cancelled'
}

export interface PendingPermissionInteraction extends PendingInteractionBase {
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

export interface PendingElicitationInteraction extends PendingInteractionBase {
  kind: 'elicitation'
  serverName: string
  message: string
  mode?: string
  url?: string
  requestedSchema?: unknown
}

export type PendingInteraction = PendingPermissionInteraction | PendingElicitationInteraction

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

export type SdkTransportDirection = 'inbound' | 'outbound'
export type ChannelLogDirection = 'inbound' | 'outbound' | 'internal'
export type SdkTransportEventName =
  | 'query.start'
  | 'query.cancel'
  | 'query.completed'
  | 'query.failed'
  | 'query.cancelled'
  | 'message'
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

export interface SessionPersistentLogEntry {
  cursor: number
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
  | { type: 'interaction.permission.respond'; permissionId: string; decision: 'approve' | 'deny'; selectedSuggestion?: PermissionSuggestion | null; content?: Record<string, string | number | boolean | string[]> }
  | { type: 'interaction.elicitation.respond'; requestId: string; response: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> } }

export type RunnerRuntimeEvent =
  | { type: 'run.started'; sessionId?: string }
  | { type: 'run.state_changed'; state: SessionRunState; sessionId?: string }
  | { type: 'run.completed'; messageCount: number; sessionId?: string }
  | { type: 'run.failed'; error: string; stack?: string; sessionId?: string }
  | { type: 'run.cancelled'; sessionId?: string }
  | ({ type: 'sdk.message'; payload: SDKMessage; parsed?: SessionMessage; livePreview?: TranscriptLivePreviewState } & RuntimeEnvelopeBase)
  | ({ type: 'sdk.control.requested'; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'sdk.control.resolved'; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | { type: 'sdk.transport'; event: SdkTransportEvent }

export type SessionEvent =
  | { type: 'session.run.queued'; runId: string; sessionId?: string }
  | { type: 'session.run.started'; runId: string; sessionId?: string }
  | { type: 'session.run.state_changed'; runId: string; state: SessionRunState; sessionId?: string }
  | { type: 'session.run.completed'; runId: string; sessionId?: string; exitCode?: number | null; error?: string }
  | { type: 'session.run.failed'; runId?: string; sessionId?: string; error: string }
  | { type: 'session.run.cancelled'; runId: string; sessionId?: string }
  | ({ type: 'session.sdk.message'; runId: string; payload: SDKMessage; parsed?: SessionMessage; livePreview?: TranscriptLivePreviewState } & RuntimeEnvelopeBase)
  | ({ type: 'session.sdk.control.requested'; runId: string; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | ({ type: 'session.sdk.control.resolved'; runId: string; interaction: PendingInteraction; payload?: unknown } & RuntimeEnvelopeBase)
  | { type: 'session.sdk.transport'; runId: string; event: SdkTransportEvent }
  | { type: 'session.error'; runId?: string; error: string }

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
