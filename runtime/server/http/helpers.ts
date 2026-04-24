import type { RunRegistry } from '../../orchestration/run-registry.js'
import type { ConfigRegistry } from '../../config/registry.js'

type LarkConfig = {
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  botName: string
}

export function getLarkConfigStatus(lark: LarkConfig) {
  return {
    configured: Boolean(lark.appId && lark.appSecret),
    hasAppId: Boolean(lark.appId),
    hasAppSecret: Boolean(lark.appSecret),
    hasEncryptKey: Boolean(lark.encryptKey),
    hasVerificationToken: Boolean(lark.verificationToken),
    botName: lark.botName,
  }
}

export function getProjectDirs(configRegistry: ConfigRegistry): string[] {
  const dirs = configRegistry.listAgents().map((agent) => agent.projectDir)
  return [...new Set(dirs.map((dir) => dir.trim()).filter(Boolean))]
}

export function toActiveRunSummary(runRegistry: RunRegistry, runId?: string | null) {
  if (!runId) return null
  const run = runRegistry.get(runId)
  if (!run) return null
  const state = run.runStatus === 'running'
    ? 'running'
    : run.runStatus === 'requires_action'
      ? 'requires_action'
      : run.runStatus === 'success'
        ? 'completed'
        : 'failed'
  return {
    runId: run.runId,
    state,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  }
}
