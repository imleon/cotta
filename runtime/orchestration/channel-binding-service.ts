import type { SessionRegistry } from './session-registry.js'
import type { SqliteConfigRepository } from '../storage/sqlite/config-repository.js'

export class ChannelBindingService {
  constructor(
    private readonly deps: {
      configRepository: SqliteConfigRepository
      sessionRegistry: SessionRegistry
    },
  ) {}

  bindChannel(channelId: string, sessionId: string, agentId: string): void {
    const existingSession = this.deps.sessionRegistry.get(sessionId)
    const existingChannelId = existingSession?.channelId
    const previousSessionIdForChannel = this.deps.sessionRegistry.findByChannelId(channelId)?.sessionId

    this.deps.configRepository.bindChannelToSession(channelId, sessionId)

    // DB has been written successfully, proceed with in-memory synchronization
    // Even if memory sync throws (unlikely), DB state remains consistent for the next startup

    if (existingChannelId && existingChannelId !== channelId) {
      this.deps.sessionRegistry.releaseChannel(existingChannelId)
    }

    if (previousSessionIdForChannel && previousSessionIdForChannel !== sessionId) {
      this.deps.sessionRegistry.releaseChannel(channelId)
    }
    
    this.deps.sessionRegistry.ensure(sessionId, agentId)
    this.deps.sessionRegistry.claimChannel(sessionId, channelId)
  }

  clearChannel(channelId: string): void {
    this.deps.configRepository.clearChannelSessionBinding(channelId)
    this.deps.sessionRegistry.releaseChannel(channelId)
  }
}
