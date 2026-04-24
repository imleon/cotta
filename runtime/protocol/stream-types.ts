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
  runId?: string
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
