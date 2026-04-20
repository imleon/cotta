import type {
  SessionEvent,
  SessionMessage,
  SessionMessageBlock,
  SessionRunState,
  SessionSummary,
} from '../contract/runtime'
import type { TimelinePendingInteraction } from './interaction'
import type { TimelineRenderableItemModel } from './timeline'

export type SessionMessageModel = SessionMessage
export type SessionMessageBlockModel = SessionMessageBlock
export type SessionSummaryModel = SessionSummary
export type SessionRunStateModel = SessionRunState
export type PendingInteractionModel = TimelinePendingInteraction
export type SessionEventModel = SessionEvent
export type TimelineItemModel = TimelineRenderableItemModel
