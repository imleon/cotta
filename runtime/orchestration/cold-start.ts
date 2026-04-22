import type { ConfigRegistry } from '../config/registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { ChannelClaimPlan } from './types.js'

export async function buildColdStartClaimPlans(input: {
  config: ConfigRegistry
  sessions: SessionRegistry
}): Promise<ChannelClaimPlan[]> {
  const channels = input.config.listChannels().filter((c) => c.enabled)
  const claimedSessionIds = new Set<string>()
  for (const existing of input.sessions.list()) {
    claimedSessionIds.add(existing.sessionId)
  }

  const plans: ChannelClaimPlan[] = []

  for (const channel of channels) {
    // If this channel already has a binding in current process, keep it.
    const bound = input.sessions.findByChannelId(channel.channelId)
    if (bound) {
      plans.push({
        channelId: channel.channelId,
        agentId: channel.agentId,
        sessionId: bound.sessionId,
        mode: 'resume',
        reason: 'existing_claim',
      })
      claimedSessionIds.add(bound.sessionId)
      continue
    }

    // If the channel is configured with a current session id, bind to it.
    if (channel.currentSdkSessionId && !claimedSessionIds.has(channel.currentSdkSessionId)) {
      plans.push({
        channelId: channel.channelId,
        agentId: channel.agentId,
        sessionId: channel.currentSdkSessionId,
        mode: 'resume',
        reason: 'configured_binding',
      })
      claimedSessionIds.add(channel.currentSdkSessionId)
    }
  }

  return plans
}

export function applyColdStartClaimPlans(input: {
  sessions: SessionRegistry
  plans: ChannelClaimPlan[]
}): void {
  for (const plan of input.plans) {
    input.sessions.ensure(plan.sessionId, plan.agentId, {
      channelId: plan.channelId,
    })
  }
}
