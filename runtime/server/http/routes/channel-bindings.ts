import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { RuntimeConfig } from '../../../config/schema.js'
import type { SessionRegistry } from '../../../orchestration/session-registry.js'
import type { SessionRecord } from '../../../orchestration/types.js'
import type { SqliteConfigRepository } from '../../../storage/sqlite/config-repository.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

type SessionSummary = {
  id: string
  title: string
  updatedAt: number
}

type ChannelSummary = RuntimeConfig['channels'][number]
type AgentSummary = RuntimeConfig['agents'][number]

type CandidateSession = {
  sessionId: string
  title?: string
  updatedAt: number
  isCurrent: boolean
  // If present, this session is already bound to another channel.
  claimedByChannelId?: string
}

type BoundSession = {
  sessionId: string
  title?: string
  updatedAt: number
  sessionStatus?: string
  activeRunId?: string
}

function buildConfigMaps(config: RuntimeConfig) {
  return {
    channelById: new Map(config.channels.map((channel) => [channel.channelId, channel])),
    agentById: new Map(config.agents.map((agent) => [agent.agentId, agent])),
  }
}

function findRuntimeSessionByChannelId(sessionRegistry: SessionRegistry, channelId: string): SessionRecord | null {
  return sessionRegistry.findByChannelId(channelId)
}

async function listPersistedSessionsByProjectDirCached(
  projectDir: string,
  cache: Map<string, SessionSummary[]>,
  listSessionsByProjectDir: (dir: string) => Promise<SessionSummary[]>,
): Promise<SessionSummary[]> {
  const existing = cache.get(projectDir)
  if (existing) return existing
  const sessions = await listSessionsByProjectDir(projectDir)
  cache.set(projectDir, sessions)
  return sessions
}

async function buildChannelBindingItem(
  channel: ChannelSummary,
  agent: AgentSummary | undefined,
  sessionRegistry: SessionRegistry,
  listSessionsByProjectDir: (dir: string) => Promise<SessionSummary[]>,
  persistedSessionsCache: Map<string, SessionSummary[]>,
  claimedChannelBySessionId: Map<string, string>,
): Promise<{
  channelId: string
  boundSession: BoundSession | null
  candidateSessions: CandidateSession[]
}> {
  const runtimeSession = findRuntimeSessionByChannelId(sessionRegistry, channel.channelId)
  const currentSessionId = runtimeSession?.sessionId ?? channel.currentSdkSessionId ?? null

  const candidates = new Map<string, CandidateSession>()
  let titleByCurrentSessionId: string | undefined

  if (agent) {
    const persistedSessions = await listPersistedSessionsByProjectDirCached(
      agent.projectDir,
      persistedSessionsCache,
      listSessionsByProjectDir,
    )
    for (const session of persistedSessions) {
      const isCurrent = session.id === currentSessionId
      const claimedByChannelId = claimedChannelBySessionId.get(session.id)
      candidates.set(session.id, {
        sessionId: session.id,
        ...(session.title ? { title: session.title } : {}),
        updatedAt: session.updatedAt,
        isCurrent,
        ...(claimedByChannelId && claimedByChannelId !== channel.channelId ? { claimedByChannelId } : {}),
      })
      if (isCurrent && session.title) titleByCurrentSessionId = session.title
    }
  }

  for (const runtime of sessionRegistry.list()) {
    if (runtime.agentId !== channel.agentId) continue
    const existing = candidates.get(runtime.sessionId)
    const claimedByChannelId = claimedChannelBySessionId.get(runtime.sessionId)
    const next: CandidateSession = {
      sessionId: runtime.sessionId,
      ...(existing?.title ? { title: existing.title } : {}),
      updatedAt: Math.max(existing?.updatedAt ?? 0, runtime.updatedAt),
      isCurrent: runtime.sessionId === currentSessionId,
      ...(claimedByChannelId && claimedByChannelId !== channel.channelId ? { claimedByChannelId } : {}),
    }
    candidates.set(runtime.sessionId, next)
  }

  if (currentSessionId && !candidates.has(currentSessionId)) {
    const claimedByChannelId = claimedChannelBySessionId.get(currentSessionId)
    candidates.set(currentSessionId, {
      sessionId: currentSessionId,
      ...(titleByCurrentSessionId ? { title: titleByCurrentSessionId } : {}),
      updatedAt: runtimeSession?.updatedAt ?? Date.now(),
      isCurrent: true,
      ...(claimedByChannelId && claimedByChannelId !== channel.channelId ? { claimedByChannelId } : {}),
    })
  }

  const candidateSessions = [...candidates.values()].sort((left, right) => right.updatedAt - left.updatedAt)

  const boundSession = currentSessionId
    ? {
        sessionId: currentSessionId,
        ...(candidateSessions.find((item) => item.sessionId === currentSessionId)?.title
          ? { title: candidateSessions.find((item) => item.sessionId === currentSessionId)?.title }
          : {}),
        updatedAt: runtimeSession?.updatedAt ?? Date.now(),
        ...(runtimeSession?.sessionStatus ? { sessionStatus: runtimeSession.sessionStatus } : {}),
        ...(runtimeSession?.activeRunId ? { activeRunId: runtimeSession.activeRunId } : {}),
      }
    : null

  return {
    channelId: channel.channelId,
    boundSession,
    candidateSessions,
  }
}

function buildClaimedChannelBySessionIdFromConfig(config: RuntimeConfig): Map<string, string> {
  const claimed = new Map<string, string>()
  for (const channel of config.channels) {
    if (channel.currentSdkSessionId) {
      claimed.set(channel.currentSdkSessionId, channel.channelId)
    }
  }
  return claimed
}

export function registerChannelBindingRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  configRepository: SqliteConfigRepository
  sessionRegistry: SessionRegistry
  listSessionsByProjectDir: (dir: string) => Promise<SessionSummary[]>
}) {
  app.get('/api/channels/session-bindings', async (c) => {
    try {
      const config = input.configRepository.loadRuntimeConfig()
      const { agentById } = buildConfigMaps(config)
      const persistedSessionsCache = new Map<string, SessionSummary[]>()
      const claimedChannelBySessionId = buildClaimedChannelBySessionIdFromConfig(config)

      const items = await Promise.all(
        config.channels.map(async (channel) => await buildChannelBindingItem(
          channel,
          agentById.get(channel.agentId),
          input.sessionRegistry,
          input.listSessionsByProjectDir,
          persistedSessionsCache,
          claimedChannelBySessionId,
        )),
      )

      return c.json({ items })
    } catch (error) {
      input.logger.error('http:channel-bindings:list:error', {
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to load channel bindings' }, 500)
    }
  })

  app.post('/api/channels/:channelId/session-binding/use', async (c) => {
    const startedAt = Date.now()
    try {
      const channelId = c.req.param('channelId').trim()
      const body = await c.req.json().catch(() => null)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!channelId || !sessionId) {
        return c.json({ error: 'channelId and sessionId are required' }, 400)
      }

      const config = input.configRepository.loadRuntimeConfig()
      const { channelById, agentById } = buildConfigMaps(config)
      const channel = channelById.get(channelId)
      if (!channel) return c.json({ error: `Channel not found: ${channelId}` }, 404)
      const agent = agentById.get(channel.agentId)
      if (!agent) return c.json({ error: `Agent not found for channel ${channel.channelId}: ${channel.agentId}` }, 400)

      const claimedChannelBySessionId = buildClaimedChannelBySessionIdFromConfig(config)
      const claimedBy = claimedChannelBySessionId.get(sessionId)
      if (claimedBy && claimedBy !== channel.channelId) {
        return c.json({ error: `Session ${sessionId} is already bound to channel ${claimedBy}` }, 409)
      }

      const persistedSessions = await input.listSessionsByProjectDir(agent.projectDir)
      const runtimeMatch = input.sessionRegistry.get(sessionId)
      const persistedMatch = persistedSessions.find((session) => session.id === sessionId)
      if (!runtimeMatch && !persistedMatch) {
        return c.json({ error: `Session not found: ${sessionId}` }, 404)
      }
      if (runtimeMatch && runtimeMatch.agentId !== channel.agentId) {
        return c.json({ error: `Session ${sessionId} belongs to another agent` }, 400)
      }

      input.sessionRegistry.ensure(sessionId, channel.agentId)
      input.sessionRegistry.claimChannel(sessionId, channel.channelId)
      input.configRepository.updateChannelCurrentSdkSessionId(channel.channelId, sessionId)

      const refreshedConfig = input.configRepository.loadRuntimeConfig()
      const refreshedClaimMap = buildClaimedChannelBySessionIdFromConfig(refreshedConfig)
      const item = await buildChannelBindingItem(
        channel,
        agent,
        input.sessionRegistry,
        input.listSessionsByProjectDir,
        new Map([[agent.projectDir, persistedSessions]]),
        refreshedClaimMap,
      )
      input.logger.info('http:channel-binding:use:success', {
        channelId,
        sessionId,
        durationMs: Date.now() - startedAt,
      })
      return c.json({ item })
    } catch (error) {
      input.logger.error('http:channel-binding:use:error', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to bind session' }, 500)
    }
  })

  app.post('/api/channels/:channelId/session-binding/new', async (c) => {
    const startedAt = Date.now()
    try {
      const channelId = c.req.param('channelId').trim()
      if (!channelId) return c.json({ error: 'channelId is required' }, 400)

      const config = input.configRepository.loadRuntimeConfig()
      const { channelById, agentById } = buildConfigMaps(config)
      const channel = channelById.get(channelId)
      if (!channel) return c.json({ error: `Channel not found: ${channelId}` }, 404)
      const agent = agentById.get(channel.agentId)
      if (!agent) return c.json({ error: `Agent not found for channel ${channel.channelId}: ${channel.agentId}` }, 400)

      const sessionId = randomUUID()
      input.sessionRegistry.ensure(sessionId, channel.agentId)
      input.sessionRegistry.claimChannel(sessionId, channel.channelId)
      input.configRepository.updateChannelCurrentSdkSessionId(channel.channelId, sessionId)

      const item = await buildChannelBindingItem(
        channel,
        agent,
        input.sessionRegistry,
        input.listSessionsByProjectDir,
        new Map<string, SessionSummary[]>(),
        buildClaimedChannelBySessionIdFromConfig(input.configRepository.loadRuntimeConfig()),
      )
      input.logger.info('http:channel-binding:new:success', {
        channelId,
        sessionId,
        durationMs: Date.now() - startedAt,
      })
      return c.json({ item })
    } catch (error) {
      input.logger.error('http:channel-binding:new:error', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to create and bind session' }, 500)
    }
  })
}
