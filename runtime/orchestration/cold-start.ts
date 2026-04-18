import { randomUUID } from 'node:crypto'
import type { ConfigRegistry } from '../config/registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { ChannelClaimPlan } from './types.js'
import { getChannelClaim, setExclusiveChannelClaim } from '../storage/fs/channel-claims.js'

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

    const agent = input.config.getAgent(channel.agentId)
    if (!agent) {
      throw new Error(`Agent not found for channel ${channel.channelId}: ${channel.agentId}`)
    }

    // Prefer a persisted channel -> session claim over projectDir heuristics.
    const persistedClaim = await getChannelClaim(channel.channelId)
    if (
      persistedClaim
      && persistedClaim.agentId === channel.agentId
      && !claimedSessionIds.has(persistedClaim.sessionId)
    ) {
      plans.push({
        channelId: channel.channelId,
        agentId: channel.agentId,
        sessionId: persistedClaim.sessionId,
        mode: 'resume',
        reason: 'persisted_claim',
      })
      claimedSessionIds.add(persistedClaim.sessionId)
      continue
    }

    // No persisted claim: allocate a new session id for this channel (avoid projectDir heuristics).
    const newSessionId = randomUUID()
    plans.push({
      channelId: channel.channelId,
      agentId: channel.agentId,
      sessionId: newSessionId,
      mode: 'new',
      reason: 'generated_new_session',
    })
    claimedSessionIds.add(newSessionId)
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

export async function persistColdStartClaimPlans(plans: ChannelClaimPlan[]): Promise<void> {
  for (const plan of plans) {
    await setExclusiveChannelClaim({
      channelId: plan.channelId,
      agentId: plan.agentId,
      sessionId: plan.sessionId,
    })
  }
}
