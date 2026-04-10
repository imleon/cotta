import type { StreamPreviewState } from '../shared/message-types.js'

export const LARK_STREAMING_PHASES = {
  idle: 'idle',
  creating: 'creating',
  streaming: 'streaming',
  completed: 'completed',
  aborted: 'aborted',
  terminated: 'terminated',
  creation_failed: 'creation_failed',
} as const

export type LarkStreamingPhase = (typeof LARK_STREAMING_PHASES)[keyof typeof LARK_STREAMING_PHASES]

export type LarkTerminalReason = 'normal' | 'error' | 'abort' | 'unavailable' | 'creation_failed'

export const LARK_TERMINAL_PHASES: ReadonlySet<LarkStreamingPhase> = new Set([
  LARK_STREAMING_PHASES.completed,
  LARK_STREAMING_PHASES.aborted,
  LARK_STREAMING_PHASES.terminated,
  LARK_STREAMING_PHASES.creation_failed,
])

export const LARK_PHASE_TRANSITIONS: Record<LarkStreamingPhase, ReadonlySet<LarkStreamingPhase>> = {
  idle: new Set(['creating', 'aborted', 'terminated']),
  creating: new Set(['streaming', 'creation_failed', 'aborted', 'terminated']),
  streaming: new Set(['completed', 'aborted', 'terminated']),
  completed: new Set(),
  aborted: new Set(),
  terminated: new Set(),
  creation_failed: new Set(),
}

export interface LarkStreamingTextState {
  accumulatedText: string
  completedText: string
  lastFlushedText: string
  previewState: StreamPreviewState | null
}

export interface LarkCardState {
  cardKitCardId: string | null
  originalCardKitCardId: string | null
  cardKitSequence: number
  cardMessageId: string | null
}

export const LARK_THROTTLE = {
  CARDKIT_MS: 100,
  PATCH_MS: 1500,
  LONG_GAP_THRESHOLD_MS: 2000,
  BATCH_AFTER_GAP_MS: 300,
} as const

export const LARK_EMPTY_REPLY_FALLBACK_TEXT = 'Done.'
