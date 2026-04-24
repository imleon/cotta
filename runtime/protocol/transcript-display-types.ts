import type { TranscriptAssistantUsage, TranscriptSemanticKind } from './transcript-normalizer.js'
import type { SessionMessage } from './session-contract-types.js'
import type { StreamEventAnchorKind, StreamRenderedPreviewState } from './stream-types.js'

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
  raw?: unknown
  attachedToParent?: boolean
  defaultCollapsed?: boolean
  display?: ToolResultDisplayMeta
}

export type DisplayFragment =
  | DisplayFragmentText
  | DisplayFragmentThinking
  | DisplayFragmentToolUse
  | DisplayFragmentToolResult

export interface DisplayAssistantFooter {
  stopReason?: string | null
  model?: string | null
  usage?: TranscriptAssistantUsage | null
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

export type DisplayItem =
  | UserDisplayItem
  | AssistantDisplayItem

export type TimelineRenderableItem = DisplayItem | TimelineLivePreviewItem
export type TimelineOverlayItem = TimelineLivePreviewItem

export interface TranscriptLookup {
  toolUseAtomsByToolUseId: Map<string, TranscriptAtom>
  toolResultAtomsByToolUseId: Map<string, TranscriptAtom>
  atomsByMessageId: Map<string, TranscriptAtom[]>
  siblingToolUseIdsByToolUseId: Map<string, string[]>
  resolvedToolUseIds: Set<string>
}
