import type { StreamAnimationCursor, StreamPreviewState } from '../../protocol/stream-types.js'

export const LARK_THROTTLE = {
  CARDKIT_MS: 100,
  PATCH_MS: 1500,
  LONG_GAP_THRESHOLD_MS: 2000,
  BATCH_AFTER_GAP_MS: 300,
} as const

export const LARK_EMPTY_REPLY_FALLBACK_TEXT = '已完成，但没有提取到可发送的文本回复。'

export const LARK_STREAMING_PHASES = {
  idle: 'idle',
  creating: 'creating',
  streaming: 'streaming',
  completed: 'completed',
  aborted: 'aborted',
  creation_failed: 'creation_failed',
} as const

export type LarkStreamingPhase = typeof LARK_STREAMING_PHASES[keyof typeof LARK_STREAMING_PHASES]
export type LarkTerminalReason = 'normal' | 'error' | 'abort' | 'creation_failed'

export const LARK_TERMINAL_PHASES = new Set<LarkStreamingPhase>([
  LARK_STREAMING_PHASES.completed,
  LARK_STREAMING_PHASES.aborted,
  LARK_STREAMING_PHASES.creation_failed,
])

export const LARK_PHASE_TRANSITIONS: Record<LarkStreamingPhase, Set<LarkStreamingPhase>> = {
  [LARK_STREAMING_PHASES.idle]: new Set([
    LARK_STREAMING_PHASES.creating,
    LARK_STREAMING_PHASES.completed,
    LARK_STREAMING_PHASES.aborted,
    LARK_STREAMING_PHASES.creation_failed,
  ]),
  [LARK_STREAMING_PHASES.creating]: new Set([
    LARK_STREAMING_PHASES.streaming,
    LARK_STREAMING_PHASES.creation_failed,
    LARK_STREAMING_PHASES.completed,
    LARK_STREAMING_PHASES.aborted,
  ]),
  [LARK_STREAMING_PHASES.streaming]: new Set([
    LARK_STREAMING_PHASES.completed,
    LARK_STREAMING_PHASES.aborted,
    LARK_STREAMING_PHASES.creation_failed,
  ]),
  [LARK_STREAMING_PHASES.completed]: new Set(),
  [LARK_STREAMING_PHASES.aborted]: new Set(),
  [LARK_STREAMING_PHASES.creation_failed]: new Set(),
}

export type LarkCardState = {
  cardKitCardId: string | null
  originalCardKitCardId: string | null
  cardKitSequence: number
  cardMessageId: string | null
}

export type LarkStreamingTextState = {
  accumulatedText: string
  completedText: string
  lastFlushedText: string
  previewState: StreamPreviewState | null
  cursor: StreamAnimationCursor | null
  animationDone: boolean
}
