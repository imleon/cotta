import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Hono } from 'hono'
import type { ConfigRegistry } from '../../../config/registry.js'
import type { RunRegistry } from '../../../orchestration/run-registry.js'
import type { SessionRegistry } from '../../../orchestration/session-registry.js'
import type { RunRecord, SessionRecord } from '../../../orchestration/types.js'
import type { WorkerHealthSnapshot } from '../../../orchestration/worker-governance-service.js'
import type { AppEnv } from '../app-env.js'
import { getProjectDirs } from '../helpers.js'
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

export function registerStatusRoutes(app: Hono<AppEnv>, input: {
  config: Config
  configRegistry: ConfigRegistry
  sessionRegistry: SessionRegistry
  runRegistry: RunRegistry
  listSessionsByProjectDir: (dir: string) => Promise<SessionSummary[]>
  listSessionsByProjectDirs: (dirs: string[]) => Promise<SessionSummary[]>
  getWorkerHealthBySessionId?: () => Record<string, WorkerHealthSnapshot>
}) {
  app.get('/api/status', async (c) => {
    const startedAt = Date.now()
    const logger = c.get('logger')
    try {
      const configuredAgents = input.configRegistry.listAgents()
      const projectDirs = getProjectDirs(input.configRegistry)
      const persistedSessions = projectDirs.length > 0
        ? await input.listSessionsByProjectDirs(projectDirs)
        : []
      const perAgentPersistedSessions = await Promise.all(
        configuredAgents.map(async (agent) => ({
          agentId: agent.agentId,
          sessions: await input.listSessionsByProjectDir(agent.projectDir),
        })),
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
          agent: {
            agentId: agent.agentId,
            projectDir: agent.projectDir,
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
            ...(agent.allowTools ? { allowTools: agent.allowTools } : {}),
            ...(agent.allowSkills ? { allowSkills: agent.allowSkills } : {}),
            ...(agent.mcpServers ? { mcpServers: agent.mcpServers } : {}),
            ...(agent.env ? { env: agent.env } : {}),
            ...(agent.promptConfig ? { promptConfig: agent.promptConfig } : {}),
          },
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
