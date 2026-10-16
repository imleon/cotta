import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { isTimelineLocalCommandCaveatMessage, type SessionTimelineResponse, type TurnSummary } from '@cotta/shared'

type ProjectedSessionTimeline = Omit<
  SessionTimelineResponse,
  | 'state'
  | 'awaySummary'
  | 'tasks'
  | 'turnOptions'
  | 'contextUsage'
  | 'liveBackgroundTasks'
  | 'runState'
  | 'activity'
  | 'pendingPermission'
  | 'snapshotFromTurnId'
  | 'hasNewer'
  | 'anchorTurnId'
  | 'runtimeTurnProjection'
>
export type TimelinePrimaryTurn = { uuid: string; timestamp: number | null; userCwd?: string; responseCwd?: string }
export type TimelineOwnedMessage = { ownerTurnId: string; message: SessionMessage }

type OrganizedTurn = TurnSummary & { messages: SessionMessage[] }

function isSyntheticUserMessage(message: SessionMessage): boolean {
  return message.type === 'user' && 'isSynthetic' in message && message.isSynthetic === true
}

export function projectSessionTimeline(sessionId: string, primaryTurns: TimelinePrimaryTurn[], ownedMessages: TimelineOwnedMessage[]): ProjectedSessionTimeline {
  const turns: OrganizedTurn[] = primaryTurns.map(({ uuid, timestamp, userCwd, responseCwd }) => ({
    primaryUserUuid: uuid,
    ...(timestamp === null ? {} : { primaryUserTimestampMs: timestamp }),
    ...(userCwd ? { userCwd } : {}),
    ...(responseCwd ? { responseCwd } : {}),
    messages: [],
  }))
  const turnsById = new Map(turns.map((turn) => [turn.primaryUserUuid, turn]))

  for (const { ownerTurnId, message } of ownedMessages) {
    const localCommand = message.type === 'system' && (message as Record<string, unknown>).subtype === 'local_command'
    if ((!localCommand && message.type !== 'user' && message.type !== 'assistant') || isSyntheticUserMessage(message) || isTimelineLocalCommandCaveatMessage(message)) continue
    turnsById.get(ownerTurnId)?.messages.push(message)
  }

  return { sessionId, turns, hasMore: false, nextCursor: null }
}
