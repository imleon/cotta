import { StaticConfigRegistry } from '../config/registry.js'
import type { RuntimeConfig } from '../config/schema.js'
import { Orchestrator } from '../orchestration/orchestrator.js'
import { RunRegistry } from '../orchestration/run-registry.js'
import { SessionRegistry } from '../orchestration/session-registry.js'
import { WorkerManager } from '../execution/worker-manager.js'
import { SdkSessionWorkerFactory } from '../execution/sdk-session-worker.js'
import { applyColdStartClaimPlans, buildColdStartClaimPlans } from '../orchestration/cold-start.js'
import { ENV } from '../config/env.js'
import { appendSessionSdkRawLog } from '../storage/fs/transport-logs.js'
import { createSqliteDatabase } from '../storage/sqlite/db.js'
import { SqliteConfigRepository } from '../storage/sqlite/config-repository.js'
import { createLogger, type Logger } from '../server/logger.js'

export type RuntimeContext = {
  logger: Logger
  defaultAgentId: string | null
  configDbPath: string
  runtimeConfig: RuntimeConfig
  configRepository: SqliteConfigRepository
  configRegistry: StaticConfigRegistry
  sessionRegistry: SessionRegistry
  runRegistry: RunRegistry
  workerManager: WorkerManager
  orchestrator: Orchestrator
}

export function createRuntime(input?: { configDbPath?: string }): RuntimeContext {
  const logger = createLogger('runtime')
  const configDbPath = input?.configDbPath || ENV.configDbPath
  const db = createSqliteDatabase(configDbPath)
  const configRepository = new SqliteConfigRepository(db)
  const runtimeConfig = configRepository.loadRuntimeConfig()
  const configRegistry = new StaticConfigRegistry(runtimeConfig)
  const defaultAgentId = runtimeConfig.agents[0]?.agentId ?? null

  const sessionRegistry = new SessionRegistry()
  const runRegistry = new RunRegistry()
  const workerManager = new WorkerManager(new SdkSessionWorkerFactory())

  const orchestrator = new Orchestrator({
    configRegistry,
    sessionRegistry,
    runRegistry,
    workerManager,
    logger,
    sdkRawLogWriter: appendSessionSdkRawLog,
  })

  return {
    logger,
    defaultAgentId,
    configDbPath,
    runtimeConfig,
    configRepository,
    configRegistry,
    sessionRegistry,
    runRegistry,
    workerManager,
    orchestrator,
  }
}

export async function bootstrapColdStart(
  runtime: Pick<RuntimeContext, 'configRegistry' | 'sessionRegistry'>,
): Promise<void> {
  const plans = await buildColdStartClaimPlans({
    config: runtime.configRegistry,
    sessions: runtime.sessionRegistry,
  })
  applyColdStartClaimPlans({
    sessions: runtime.sessionRegistry,
    plans,
  })
}
