import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { ConfigRegistry } from '../../../config/registry.js'
import type { RunRegistry } from '../../../orchestration/run-registry.js'
import type { SessionRegistry } from '../../../orchestration/session-registry.js'
import type { AgentTemplate, RunRecord, SessionRecord } from '../../../orchestration/types.js'
import type { WorkerHealthSnapshot } from '../../../orchestration/worker-governance-service.js'
import type { AppEnv } from '../app-env.js'
import { sendInternalError } from '../validation.js'

type Config = {
  host: string
  port: number
  authEnabled: boolean
}

type SessionSummary = {
  id: string
  title: string
  updatedAt: number
}

type AgentPersistedSessions = {
  agentId: string
  sessions: SessionSummary[]
}

type SessionLastRun = {
  runId: string
  runStatus: RunRecord['runStatus']
  createdAt: number
  updatedAt: number
  pendingActionKind?: string
  resultSummary?: RunRecord['resultSummary']
}

function getLastRunBySessionId(runRegistry: RunRegistry): Map<string, RunRecord> {
  const latest = new Map<string, RunRecord>()
  for (const run of runRegistry.list()) {
    const existing = latest.get(run.sessionId)
    if (!existing || run.updatedAt > existing.updatedAt) {
      latest.set(run.sessionId, run)
    }
  }
  return latest
}

function toLastRun(run: RunRecord | null): SessionLastRun | null {
  if (!run) return null
  return {
    runId: run.runId,
    runStatus: run.runStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.pendingAction?.kind ? { pendingActionKind: run.pendingAction.kind } : {}),
    ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
  }
}

let cachedPackageVersion: string | null = null
function getPackageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const packageJsonPath = resolve(currentDir, '../../../../package.json')
    const raw = readFileSync(packageJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    cachedPackageVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch (_readError) {
    cachedPackageVersion = 'unknown'
  }
  return cachedPackageVersion
}

function toRuntimeSessionSnapshot(runtime: SessionRecord | null) {
  if (!runtime) return null
  return {
    agentId: runtime.agentId,
    sessionScope: runtime.sessionScope,
    ...(runtime.channelId ? { channelId: runtime.channelId } : {}),
    ...(runtime.workerRef ? { workerRef: runtime.workerRef } : {}),
    ...(runtime.sessionStatus ? { sessionStatus: runtime.sessionStatus } : {}),
    ...(runtime.activeRunId ? { activeRunId: runtime.activeRunId } : {}),
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
  }
}

function summarizeEnv(env: AgentTemplate['env']) {
  if (!env) return undefined
  const keys = Object.keys(env).sort()
  if (keys.length === 0) return undefined
  return {
    keys,
    count: keys.length,
  }
}

function summarizeMcpServers(mcpServers: AgentTemplate['mcpServers']) {
  if (!mcpServers) return undefined
  const names = Object.keys(mcpServers).sort()
  if (names.length === 0) return undefined
  return {
    count: names.length,
    servers: names.map((name) => {
      const raw = mcpServers[name]
      const enabled = typeof raw === 'object'
        && raw !== null
        && 'enabled' in raw
        && typeof (raw as { enabled?: unknown }).enabled === 'boolean'
        ? (raw as { enabled: boolean }).enabled
        : undefined
      return enabled === undefined ? { name } : { name, enabled }
    }),
  }
}

function summarizePromptConfig(promptConfig: AgentTemplate['promptConfig']) {
  if (!promptConfig) return undefined
  const keys = Object.keys(promptConfig).sort()
  if (keys.length === 0) return undefined
  const version = typeof promptConfig.version === 'string' || typeof promptConfig.version === 'number'
    ? String(promptConfig.version)
    : undefined
  return {
    configured: true,
    keyCount: keys.length,
    ...(version ? { version } : {}),
  }
}

export function toStatusAgentConfig(agent: AgentTemplate) {
  return {
    agentId: agent.agentId,
    projectDir: agent.projectDir,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.allowTools ? { allowTools: agent.allowTools } : {}),
    ...(agent.allowSkills ? { allowSkills: agent.allowSkills } : {}),
    ...(summarizeMcpServers(agent.mcpServers) ? { mcpSummary: summarizeMcpServers(agent.mcpServers) } : {}),
    ...(summarizeEnv(agent.env) ? { envSummary: summarizeEnv(agent.env) } : {}),
    ...(summarizePromptConfig(agent.promptConfig) ? { promptConfigSummary: summarizePromptConfig(agent.promptConfig) } : {}),
  }
}

export async function collectPersistedSessionsByAgent(
  configuredAgents: Array<{ agentId: string; projectDir: string }>,
  listSessionsByProjectDir: (dir: string) => Promise<SessionSummary[]>,
): Promise<{
  persistedSessions: SessionSummary[]
  perAgentPersistedSessions: AgentPersistedSessions[]
}> {
  const uniqueDirs = [...new Set(configuredAgents.map((agent) => agent.projectDir.trim()).filter(Boolean))]
  const sessionsByDir = new Map<string, SessionSummary[]>()

  await Promise.all(uniqueDirs.map(async (dir) => {
    sessionsByDir.set(dir, await listSessionsByProjectDir(dir))
  }))

  const perAgentPersistedSessions = configuredAgents.map((agent) => ({
    agentId: agent.agentId,
    sessions: sessionsByDir.get(agent.projectDir.trim()) ?? [],
  }))

  const persistedBySessionId = new Map<string, SessionSummary>()
  for (const sessions of sessionsByDir.values()) {
    for (const session of sessions) {
      const existing = persistedBySessionId.get(session.id)
      if (!existing || session.updatedAt > existing.updatedAt) {
        persistedBySessionId.set(session.id, session)
      }
    }
  }

  return {
    persistedSessions: [...persistedBySessionId.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    perAgentPersistedSessions,
  }
}

export function registerStatusRoutes(app: Hono<AppEnv>, input: {
  config: Config
  configRegistry: ConfigRegistry
  sessionRegistry: SessionRegistry
  runRegistry: RunRegistry
  listSessionsByProjectDir: (dir: string) => Promise<SessionSummary[]>
  getWorkerHealthBySessionId?: () => Record<string, WorkerHealthSnapshot>
}) {
  app.get('/api/status', async (c) => {
    const startedAt = Date.now()
    const logger = c.get('logger')
    try {
      const configuredAgents = input.configRegistry.listAgents()
      const { persistedSessions, perAgentPersistedSessions } = await collectPersistedSessionsByAgent(
        configuredAgents,
        input.listSessionsByProjectDir,
      )
      const runtimeSessions = input.sessionRegistry.list()
      const runtimeBySessionId = new Map(runtimeSessions.map((record) => [record.sessionId, record]))
      const lastRunBySessionId = getLastRunBySessionId(input.runRegistry)
      const configuredAgentIds = new Set(configuredAgents.map((agent) => agent.agentId))
      const workerHealthBySessionId = input.getWorkerHealthBySessionId?.() ?? {}

      const runs = input.runRegistry.list()
      let activeRuns = 0
      for (const run of runs) {
        if (run.runStatus === 'running' || run.runStatus === 'requires_action') activeRuns += 1
      }

      const sessionsByStatus = {
        idle: 0,
        running: 0,
        requires_action: 0,
        unknown: 0,
      }
      for (const runtime of runtimeSessions) {
        if (runtime.sessionStatus === 'idle') sessionsByStatus.idle += 1
        else if (runtime.sessionStatus === 'running') sessionsByStatus.running += 1
        else if (runtime.sessionStatus === 'requires_action') sessionsByStatus.requires_action += 1
        else sessionsByStatus.unknown += 1
      }

      const channels = input.configRegistry.listChannels().map((channel) => {
        const connector = input.configRegistry.getConnector(channel.connectorId)
        const bound = input.sessionRegistry.findByChannelId(channel.channelId)
        return {
          channelId: channel.channelId,
          channelKey: channel.channelKey,
          ...(channel.channelName ? { channelName: channel.channelName } : {}),
          enabled: channel.enabled,
          connectorId: channel.connectorId,
          connectorType: connector?.connectorType ?? 'unknown',
          agentId: channel.agentId,
          ...(bound
            ? {
                boundSession: {
                  sessionId: bound.sessionId,
                  agentId: bound.agentId,
                  ...(bound.workerRef ? { workerRef: bound.workerRef } : {}),
                  ...(bound.sessionStatus ? { sessionStatus: bound.sessionStatus } : {}),
                  ...(bound.activeRunId ? { activeRunId: bound.activeRunId } : {}),
                  updatedAt: bound.updatedAt,
                },
              }
            : {}),
        }
      })

      const agents = configuredAgents.map((agent) => {
        const persistedForAgent = perAgentPersistedSessions.find((entry) => entry.agentId === agent.agentId)?.sessions ?? []
        const agentSessions = persistedForAgent.map((session) => {
          const runtime = runtimeBySessionId.get(session.id) ?? null
          const channelId = runtime?.channelId ?? null
          const channel = channelId ? input.configRegistry.getChannel(channelId) : null
          const connector = channel ? input.configRegistry.getConnector(channel.connectorId) : null
          const lastRun = toLastRun(lastRunBySessionId.get(session.id) ?? null)
          const summary = lastRun?.resultSummary?.brief?.trim()
            || lastRun?.resultSummary?.message?.trim()
            || session.title.trim()

          return {
            sessionId: session.id,
            title: session.title,
            summary,
            updatedAt: session.updatedAt,
            agentId: agent.agentId,
            ...(channelId ? { channelId } : {}),
            ...(channel
              ? {
                  channel: {
                    channelId: channel.channelId,
                    channelKey: channel.channelKey,
                    ...(channel.channelName ? { channelName: channel.channelName } : {}),
                    enabled: channel.enabled,
                    connectorId: channel.connectorId,
                    agentId: channel.agentId,
                  },
                }
              : {}),
            ...(connector
              ? {
                  connector: {
                    connectorId: connector.connectorId,
                    connectorType: connector.connectorType,
                  },
                }
              : {}),
            ...(lastRun ? { lastRun } : {}),
            ...(runtime
              ? {
                  runtime: {
                    ...toRuntimeSessionSnapshot(runtime),
                    ...(workerHealthBySessionId[runtime.sessionId] ? { workerHealth: workerHealthBySessionId[runtime.sessionId] } : {}),
                  },
                }
              : {}),
          }
        })
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
        const channelCount = input.configRegistry.listChannels().filter((ch) => ch.agentId === agent.agentId).length
        const activeSessionCount = agentSessions.filter((s) => {
          const runtime = (s as { runtime?: { sessionStatus?: string } }).runtime
          const status = runtime?.sessionStatus
          return status === 'running' || status === 'requires_action'
        }).length
        return {
          agent: toStatusAgentConfig(agent),
          counts: {
            sessions: agentSessions.length,
            activeSessions: activeSessionCount,
            channels: channelCount,
          },
          sessions: agentSessions,
        }
      })

      const persistedSessionIds = new Set(persistedSessions.map((session) => session.id))
      const unconfiguredSessions = runtimeSessions
        .filter((session) => !configuredAgentIds.has(session.agentId) || !persistedSessionIds.has(session.sessionId))
        .map((session) => ({
          sessionId: session.sessionId,
          agentId: session.agentId,
          updatedAt: session.updatedAt,
          ...(session.channelId ? { channelId: session.channelId } : {}),
          ...(session.sessionStatus ? { sessionStatus: session.sessionStatus } : {}),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)

      return c.json({
        generatedAt: Date.now(),
        runtime: {
          version: getPackageVersion(),
          host: input.config.host,
          port: input.config.port,
          authEnabled: input.config.authEnabled,
          nodeVersion: process.version,
          pid: process.pid,
          platform: process.platform,
          startedAt: Date.now() - Math.floor(process.uptime() * 1000),
          uptimeSec: process.uptime(),
        },
        counts: {
          agents: input.configRegistry.listAgents().length,
          channels: input.configRegistry.listChannels().length,
          connectors: input.configRegistry.listConnectors().length,
          sessionsPersisted: persistedSessions.length,
          sessionsRuntime: runtimeSessions.length,
          sessionsByStatus,
          runsInMemory: runs.length,
          activeRunsInMemory: activeRuns,
        },
        channels,
        agents,
        unconfiguredSessions,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      logger.error('http:status:error', {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      })
      return sendInternalError(c, 'status_failed', err)
    }
  })
}
