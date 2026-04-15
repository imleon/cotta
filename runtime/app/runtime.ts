import { StaticConfigRegistry } from '../config/registry.js'
import { Orchestrator } from '../orchestration/orchestrator.js'
import { RunRegistry } from '../orchestration/run-registry.js'
import { SessionRegistry } from '../orchestration/session-registry.js'
import { WorkerManager } from '../execution/worker-manager.js'
import { SdkSessionWorkerFactory } from '../execution/sdk-session-worker.js'
import { DEFAULT_AGENT_ID as CONFIG_DEFAULT_AGENT_ID, DEFAULT_RUNTIME_SETTINGS_PATH, loadRuntimeConfigSync } from '../config/load.js'
import { applyColdStartClaimPlans, buildColdStartClaimPlans } from '../orchestration/cold-start.js'
import { ENV } from '../config/env.js'

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

// Default singleton runtime used by the running server.
const defaultRuntime = createRuntime()

// Back-compat exports (existing call sites expect these symbols).
export const DEFAULT_AGENT_ID = defaultRuntime.defaultAgentId
export const RUNTIME_SETTINGS_PATH = defaultRuntime.runtimeSettingsPath
export const runtimeConfig = defaultRuntime.runtimeConfig
export const configRegistry = defaultRuntime.configRegistry
export const sessionRegistry = defaultRuntime.sessionRegistry
export const runRegistry = defaultRuntime.runRegistry
export const workerManager = defaultRuntime.workerManager
export const orchestrator = defaultRuntime.orchestrator

export async function bootstrapColdStart(): Promise<void> {
  const plans = await buildColdStartClaimPlans({
    config: defaultRuntime.configRegistry,
    sessions: defaultRuntime.sessionRegistry,
  })
  applyColdStartClaimPlans({
    sessions: defaultRuntime.sessionRegistry,
    plans,
  })
}
