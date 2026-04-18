import { config as loadDotEnv } from 'dotenv'

// Centralize dotenv + env parsing so server/runtime share one source of truth.
loadDotEnv()

function getString(name: string, fallback: string = ''): string {
  const value = process.env[name]
  return typeof value === 'string' ? value : fallback
}

function getInt(name: string, fallback: number): number {
  const raw = getString(name, '')
  if (!raw.trim()) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const ENV = {
  runtimeSettingsPath: getString('COTTA_SETTINGS_PATH', ''),

  port: getInt('PORT', 3000),
  host: getString('HOST', '0.0.0.0'),
  workspacePath: getString('WORKSPACE_PATH', './data/workspace'),
  maxConcurrentAgents: getInt('MAX_CONCURRENT_AGENTS', 2),
  agentTimeoutMs: getInt('AGENT_TIMEOUT_MS', 600_000),
  defaultModel: getString('DEFAULT_MODEL', ''),

  // Worker lifecycle governance.
  // - Set to 0 to disable idle timeout reaping.
  workerIdleTimeoutMs: getInt('WORKER_IDLE_TIMEOUT_MS', 15 * 60 * 1000),
  workerIdleSweepIntervalMs: getInt('WORKER_IDLE_SWEEP_INTERVAL_MS', 60 * 1000),
  // Worker health check (best-effort).
  // - Set to 0 to disable periodic health checks.
  workerHealthCheckIntervalMs: getInt('WORKER_HEALTH_CHECK_INTERVAL_MS', 5 * 60 * 1000),
  workerHealthCheckTimeoutMs: getInt('WORKER_HEALTH_CHECK_TIMEOUT_MS', 2_000),
  // Auto rebuild on unhealthy/error (best-effort).
  // - Set to 0 to disable automatic rebuilds.
  workerAutoRebuildCooldownMs: getInt('WORKER_AUTO_REBUILD_COOLDOWN_MS', 5 * 60 * 1000),

  authToken: getString('APP_AUTH_TOKEN', ''),
  authEnabled: getString('APP_AUTH_TOKEN', '').length > 0,

  ipcPath: './data/ipc',

  lark: {
    appId: getString('LARK_APP_ID', ''),
    appSecret: getString('LARK_APP_SECRET', ''),
    encryptKey: getString('LARK_ENCRYPT_KEY', ''),
    verificationToken: getString('LARK_VERIFICATION_TOKEN', ''),
    botName: getString('LARK_BOT_NAME', 'Cotta'),
  },
} as const
