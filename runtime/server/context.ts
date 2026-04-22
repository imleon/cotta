import { getSession, getMessagesPage, listSessionsByProjectDir, listSessionsByProjectDirs } from '../storage/fs/sessions.js'
import { readSessionPersistentLogs, readSessionSdkRawLogs } from '../storage/fs/transport-logs.js'
import type { RuntimeContext } from '../app/index.js'
import { LarkIntegrationService } from '../integrations/lark/service.js'
import { WorkerGovernanceService } from '../orchestration/worker-governance-service.js'
import { ENV } from '../config/env.js'
import { CONFIG } from './config.js'
import { createLogger, shortId } from './logger.js'

export function createServerContext(input: { runtime: RuntimeContext }) {
  const { runtime } = input
  const logger = createLogger('web')

  const getAgentProjectDirs = (): string[] => {
    const dirs = new Set<string>()
    for (const agent of runtime.configRegistry.listAgents()) {
      if (agent.projectDir) dirs.add(agent.projectDir)
    }
    return [...dirs]
  }

  const larkIntegration = new LarkIntegrationService({
    configRegistry: runtime.configRegistry,
    configRepository: runtime.configRepository,
    sessionRegistry: runtime.sessionRegistry,
    orchestrator: runtime.orchestrator,
    logger,
  })

  const workerGovernance = new WorkerGovernanceService({
    workerManager: runtime.workerManager,
    sessionRegistry: runtime.sessionRegistry,
    orchestrator: runtime.orchestrator,
    logger,
    idleTimeoutMs: ENV.workerIdleTimeoutMs,
    sweepIntervalMs: ENV.workerIdleSweepIntervalMs,
    healthCheckIntervalMs: ENV.workerHealthCheckIntervalMs,
    healthCheckTimeoutMs: ENV.workerHealthCheckTimeoutMs,
    autoRebuildCooldownMs: ENV.workerAutoRebuildCooldownMs,
  })

  const context = {
    config: CONFIG,
    logger,
    shortId,
    defaultAgentId: runtime.defaultAgentId,
    configDbPath: runtime.configDbPath,

    configRepository: runtime.configRepository,
    configRegistry: runtime.configRegistry,
    orchestrator: runtime.orchestrator,
    runRegistry: runtime.runRegistry,
    sessionRegistry: runtime.sessionRegistry,

    larkIntegration,
    getSession,
    listSessionsByProjectDir,
    getMessagesPage,
    listSessionsByProjectDirs,
    readSessionPersistentLogs: (sessionId: string, cursor: number | null, limit: number, follow: boolean) =>
      readSessionPersistentLogs(sessionId, cursor, limit, follow, getAgentProjectDirs()),
    readSessionSdkRawLogs,
    getWorkerHealthBySessionId: () => workerGovernance.getHealthBySessionId(),

    // Lifecycle hooks (explicit startup boundary).
    start: async () => {
      larkIntegration.start()
      workerGovernance.start()
    },
    stop: async () => {
      await workerGovernance.stop()
      await larkIntegration.stop()
      await runtime.workerManager.dispose()
    },
    dispose: async () => {
      await workerGovernance.stop()
      await larkIntegration.stop()
      await runtime.workerManager.dispose()
    },
  }

  return context
}

export type ServerContext = ReturnType<typeof createServerContext>
