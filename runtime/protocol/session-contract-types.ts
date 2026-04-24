import type { TranscriptBlock, TranscriptMessage } from './transcript-normalizer.js'

export type SessionRunState = 'idle' | 'queued' | 'running' | 'requires_action' | 'completed' | 'failed' | 'cancelled'
export type SessionLifecycleState = SessionRunState

export type SessionMessageBlock = TranscriptBlock
export type SessionMessage = TranscriptMessage

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  agentId?: string
  channelId?: string
  workerRef?: string
  sessionStatus?: 'idle' | 'running' | 'requires_action'
  activeRunId?: string
  sessionScope?: 'managed' | 'foreign'
}

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

export interface SessionClaim extends ChannelConversationRef {
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

export interface SessionClaimStatus {
  ref: ChannelConversationRef
  claim: SessionClaim | null
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
