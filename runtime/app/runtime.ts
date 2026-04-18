import { StaticConfigRegistry } from '../config/registry.js'
import { Orchestrator } from '../orchestration/orchestrator.js'
import { RunRegistry } from '../orchestration/run-registry.js'
import { SessionRegistry } from '../orchestration/session-registry.js'
import { WorkerManager } from '../execution/worker-manager.js'
import { SdkSessionWorkerFactory } from '../execution/sdk-session-worker.js'
import { DEFAULT_AGENT_ID as CONFIG_DEFAULT_AGENT_ID, DEFAULT_RUNTIME_SETTINGS_PATH, loadRuntimeConfigSync } from '../config/load.js'
import { applyColdStartClaimPlans, buildColdStartClaimPlans, persistColdStartClaimPlans } from '../orchestration/cold-start.js'
import { ENV } from '../config/env.js'
import { appendSessionSdkRawLog } from '../storage/fs/transport-logs.js'

export type RuntimeContext = {
  defaultAgentId: string
  runtimeSettingsPath: string
  runtimeConfig: ReturnType<typeof loadRuntimeConfigSync>
  configRegistry: StaticConfigRegistry
  sessionRegistry: SessionRegistry
  runRegistry: RunRegistry
  workerManager: WorkerManager
  orchestrator: Orchestrator
}

export function createRuntime(input?: { runtimeSettingsPath?: string }): RuntimeContext {
  const runtimeSettingsPath = input?.runtimeSettingsPath
    || ENV.runtimeSettingsPath
    || DEFAULT_RUNTIME_SETTINGS_PATH

  const runtimeConfig = loadRuntimeConfigSync(runtimeSettingsPath)
  const configRegistry = new StaticConfigRegistry(runtimeConfig)

  const sessionRegistry = new SessionRegistry()
  const runRegistry = new RunRegistry()
  const workerManager = new WorkerManager(new SdkSessionWorkerFactory())

  const orchestrator = new Orchestrator({
    configRegistry,
    sessionRegistry,
    runRegistry,
    workerManager,
    sdkRawLogWriter: appendSessionSdkRawLog,
  })

  return {
    defaultAgentId: CONFIG_DEFAULT_AGENT_ID,
    runtimeSettingsPath,
    runtimeConfig,
    configRegistry,
    sessionRegistry,
    runRegistry,
    workerManager,
    orchestrator,
  }
}

export async function bootstrapColdStart(
  runtime: Pick<RuntimeContext, 'configRegistry' | 'sessionRegistry' | 'orchestrator'>,
): Promise<void> {
  const plans = await buildColdStartClaimPlans({
    config: runtime.configRegistry,
    sessions: runtime.sessionRegistry,
  })
  applyColdStartClaimPlans({
    sessions: runtime.sessionRegistry,
    plans,
  })
  await persistColdStartClaimPlans(plans)

  // Ensure each claimed session has an attached worker so the runtime is "warm"
  // right after cold start.
  for (const plan of plans) {
    await runtime.orchestrator.ensureWorkerForSession(plan.sessionId, plan.agentId, plan.mode)
  }
}
