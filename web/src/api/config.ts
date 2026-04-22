import { extractApiError, makeApiResult, readJsonSafe, type ApiResult } from './result'

export type ConnectorConfig = {
  connectorId: string
  connectorType: string
  connectorConfig: Record<string, unknown>
}

export type ChannelConfig = {
  channelId: string
  channelKey: string
  channelName?: string
  connectorId: string
  agentId: string
  enabled: boolean
  currentSdkSessionId?: string
}

export type AgentConfig = {
  agentId: string
  agentName?: string
  modelJson: { model?: string; thinking?: unknown; effort?: string }
  projectDir: string
  permissionMode?: string
  allowToolsJson?: string[]
  allowSkillsJson?: string[]
  mcpServersJson?: Record<string, unknown>
  envJson?: Record<string, string>
  promptConfigJson?: Record<string, unknown>
}

export type RuntimeConfig = {
  connectors: ConnectorConfig[]
  channels: ChannelConfig[]
  agents: AgentConfig[]
}

export interface ConfigOverviewResponse {
  dbPath: string
  updatedAt: number | null
  config: RuntimeConfig
}

export interface ConfigSaveData {
  updatedAt: number | null
}

export async function fetchConfigOverviewRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ApiResult<ConfigOverviewResponse | null>> {
  const res = await apiFetch('/api/config/overview')
  const payload = await readJsonSafe(res) as ConfigOverviewResponse | { error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: payload && typeof payload === 'object' && 'config' in payload ? payload as ConfigOverviewResponse : null,
    error: res.ok ? null : extractApiError(payload, res.status),
  })
}

export async function saveConfigOverviewRequest(
  apiFetch: (input: string, init?: RequestInit) => Promise<Response>,
  config: RuntimeConfig,
): Promise<ApiResult<ConfigSaveData | null>> {
  const res = await apiFetch('/api/config/overview', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })
  const body = await readJsonSafe(res) as { updatedAt?: number | null; error?: string } | null
  return makeApiResult({
    ok: res.ok,
    status: res.status,
    data: res.ok ? { updatedAt: typeof body?.updatedAt === 'number' ? body.updatedAt : null } : null,
    error: res.ok ? null : extractApiError(body, res.status),
  })
}
