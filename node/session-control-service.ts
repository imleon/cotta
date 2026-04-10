import type { RunCoordinator } from './run-coordinator.js'
import { SessionBindingStore } from './session-bindings.js'
import { getSession, listAllSessions, type SessionInfo } from './sessions.js'
import type {
  ActiveRunSummary,
  ChannelConversationRef,
  ChannelInboundMessage,
  SessionBindingStatus,
} from '../shared/message-types.js'

export class SessionControlService {
  constructor(
    private readonly bindings: SessionBindingStore,
    private readonly coordinator: RunCoordinator,
  ) {}

  async getBindingStatus(ref: ChannelConversationRef): Promise<SessionBindingStatus> {
    const binding = await this.bindings.get(ref)
    const session = binding ? await getSession(binding.sessionId) : null
    const activeRun = this.toActiveRunSummary(
      this.coordinator.getLatestInterruptibleRunByConversation(ref.channel, ref.conversationKey)
      ?? (binding?.lastRunId ? this.coordinator.getRun(binding.lastRunId) : null),
    )
    return {
      ref,
      binding,
      session,
      activeRun,
    }
  }

  async bindToSession(ref: ChannelConversationRef, sessionId: string): Promise<SessionBindingStatus> {
    await this.bindings.bindSession(ref, sessionId)
    return await this.getBindingStatus(ref)
  }

  async clearBinding(ref: ChannelConversationRef): Promise<SessionBindingStatus> {
    await this.bindings.delete(ref)
    return await this.getBindingStatus(ref)
  }

  async listBindings(channel?: ChannelConversationRef['channel']): Promise<SessionBindingStatus[]> {
    const bindings = await this.bindings.list(channel)
    const uniqueSessionIds = [...new Set(bindings.map((binding) => binding.sessionId))]
    const sessions = await Promise.all(uniqueSessionIds.map(async (sessionId) => [sessionId, await getSession(sessionId)] as const))
    const sessionMap = new Map<string, SessionInfo | null>(sessions)
    return bindings
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((binding) => ({
        ref: {
          channel: binding.channel,
          conversationKey: binding.conversationKey,
          ...(binding.userKey ? { userKey: binding.userKey } : {}),
        },
        binding,
        session: sessionMap.get(binding.sessionId) ?? null,
        activeRun: binding.lastRunId ? this.toActiveRunSummary(this.coordinator.getRun(binding.lastRunId)) : null,
      }))
  }

  async listCandidateSessions(limit: number = 20): Promise<SessionInfo[]> {
    const sessions = await listAllSessions()
    return sessions
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 100)))
  }

  resolveInboundMessage(message: ChannelInboundMessage, fallbackSessionId?: string | null): ChannelInboundMessage {
    return fallbackSessionId
      ? { ...message, sessionId: fallbackSessionId }
      : message
  }

  private toActiveRunSummary(record: ReturnType<RunCoordinator['getRun']>): ActiveRunSummary | null {
    if (!record) return null
    return {
      runId: record.runId,
      state: record.state,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    }
  }
}
