import type {
  SessionMessage,
  StreamRenderedPreviewState,
  TimelineOverlayAnchor,
  TimelineOverlayKind,
  TranscriptAssistantUsage,
} from '../contract/runtime'

export interface TimelineTextFragment {
  type: 'text'
  text: string
}

export interface TimelineThinkingFragment {
  type: 'thinking'
  text?: string
  redacted?: boolean
  defaultHidden: boolean
}

export interface TimelineToolUseFragment {
  type: 'tool_use'
  name: string
  toolUseId?: string
  input?: unknown
  grouped?: boolean
}

export interface TimelineToolResultMeta {
  previewText: string
  lineCount: number
  charCount: number
  defaultExpanded: boolean
}

export interface TimelineToolResultFragment {
  type: 'tool_result'
  toolUseId?: string
  output?: unknown
  raw?: unknown
  attachedToParent?: boolean
  defaultCollapsed?: boolean
  display?: TimelineToolResultMeta
}

export type TimelineFragment =
  | TimelineTextFragment
  | TimelineThinkingFragment
  | TimelineToolUseFragment
  | TimelineToolResultFragment

export interface TimelineAssistantFooter {
  stopReason?: string | null
  model?: string | null
  usage?: TranscriptAssistantUsage | null
  completedAt?: number | null
  deltaMs?: number | null
}

export interface TimelineUserItem {
  kind: 'user'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  message: SessionMessage
  displayKind?: 'default' | 'command_input' | 'command_output'
}

export interface TimelineLivePreview {
  kind: 'live_preview'
  layer: 'overlay'
  overlayKind: TimelineOverlayKind
  anchor: TimelineOverlayAnchor
  id: string
  key: string
  timestamp: number
  preview: StreamRenderedPreviewState
}

export interface TimelineAssistantItem {
  kind: 'assistant'
  id: string
  key: string
  timestamp: number
  atomIds: string[]
  messages: SessionMessage[]
  anchorMessage: SessionMessage
  fragments: TimelineFragment[]
  footer?: TimelineAssistantFooter
  overlays?: TimelineLivePreview[]
  placeholder?: boolean
}

export type TimelineRenderableItemModel =
  | TimelineUserItem
  | TimelineAssistantItem
  | TimelineLivePreview

export function isAssistantTimelineItem(item: TimelineRenderableItemModel): item is TimelineAssistantItem {
  return item.kind === 'assistant'
}
