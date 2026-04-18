import { getSession, listAllSessions, getMessagesPage, listSessionsByProjectDir, listSessionsByProjectDirs } from '../storage/fs/sessions.js'
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

  const larkIntegration = new LarkIntegrationService({
    configRegistry: runtime.configRegistry,
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

    configRegistry: runtime.configRegistry,
    orchestrator: runtime.orchestrator,
    runRegistry: runtime.runRegistry,
    sessionRegistry: runtime.sessionRegistry,

    larkIntegration,
    getSession,
    listAllSessions,
    listSessionsByProjectDir,
    getMessagesPage,
    listSessionsByProjectDirs,
    readSessionPersistentLogs,
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
