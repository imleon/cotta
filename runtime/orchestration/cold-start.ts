import { randomUUID } from 'node:crypto'
import type { ConfigRegistry } from '../config/registry.js'
import type { SessionRegistry } from './session-registry.js'
import type { ChannelClaimPlan, SessionCandidate } from './types.js'
import { listSessionsByProjectDir } from '../storage/fs/sessions.js'

function sortByUpdatedAtDesc(items: SessionCandidate[]): SessionCandidate[] {
  return items.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

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
        reason: 'existing_binding',
      })
      claimedSessionIds.add(bound.sessionId)
      continue
    }

    const agent = input.config.getAgent(channel.agentId)
    if (!agent) {
      throw new Error(`Agent not found for channel ${channel.channelId}: ${channel.agentId}`)
    }

    const projectSessions = await listSessionsByProjectDir(agent.projectDir)
    const sortedCandidates = sortByUpdatedAtDesc(projectSessions.map((s) => ({
      sessionId: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
    })))

    // Pick the newest unclaimed session under the channel's agent.projectDir.
    let picked: SessionCandidate | null = null
    for (const candidate of sortedCandidates) {
      if (claimedSessionIds.has(candidate.sessionId)) continue
      picked = candidate
      break
    }

    if (picked) {
      plans.push({
        channelId: channel.channelId,
        agentId: channel.agentId,
        sessionId: picked.sessionId,
        mode: 'resume',
        reason: 'latest_unclaimed_session',
      })
      claimedSessionIds.add(picked.sessionId)
      continue
    }

    // No candidate: allocate a new session id for this channel.
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
