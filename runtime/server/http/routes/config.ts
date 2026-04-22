import type { Hono } from 'hono'
import type { RuntimeConfig } from '../../../config/schema.js'
import type { SqliteConfigRepository } from '../../../storage/sqlite/config-repository.js'

type Logger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function toRuntimeConfig(value: unknown): RuntimeConfig | null {
  const record = asRecord(value)
  if (!record) return null

  const connectors = Array.isArray(record.connectors) ? record.connectors : []
  const channels = Array.isArray(record.channels) ? record.channels : []
  const agents = Array.isArray(record.agents) ? record.agents : []

  return {
    connectors: connectors
      .map((entry) => {
        const item = asRecord(entry)
        if (!item) return null
        return {
          connectorId: typeof item.connectorId === 'string' ? item.connectorId.trim() : '',
          connectorType: typeof item.connectorType === 'string' ? item.connectorType.trim() : '',
          connectorConfig: asRecord(item.connectorConfig) ?? {},
        }
      })
      .filter((item): item is RuntimeConfig['connectors'][number] => Boolean(item?.connectorId)),
    channels: channels
      .map((entry) => {
        const item = asRecord(entry)
        if (!item) return null
        return {
          channelId: typeof item.channelId === 'string' ? item.channelId.trim() : '',
          channelKey: typeof item.channelKey === 'string' ? item.channelKey.trim() : '',
          ...(typeof item.channelName === 'string' && item.channelName.trim()
            ? { channelName: item.channelName.trim() }
            : {}),
          connectorId: typeof item.connectorId === 'string' ? item.connectorId.trim() : '',
          agentId: typeof item.agentId === 'string' ? item.agentId.trim() : '',
          ...(typeof item.currentSdkSessionId === 'string' && item.currentSdkSessionId.trim()
            ? { currentSdkSessionId: item.currentSdkSessionId.trim() }
            : {}),
          enabled: Boolean(item.enabled),
        }
      })
      .filter((item): item is RuntimeConfig['channels'][number] => Boolean(item?.channelId)),
    agents: agents
      .map((entry) => {
        const item = asRecord(entry)
        if (!item) return null
        return {
          agentId: typeof item.agentId === 'string' ? item.agentId.trim() : '',
          ...(typeof item.agentName === 'string' && item.agentName.trim()
            ? { agentName: item.agentName.trim() }
            : {}),
          projectDir: typeof item.projectDir === 'string' ? item.projectDir.trim() : '',
          modelJson: asRecord(item.modelJson) ?? {},
          ...(typeof item.permissionMode === 'string' && item.permissionMode.trim()
            ? { permissionMode: item.permissionMode.trim() }
            : {}),
          ...(Array.isArray(item.allowToolsJson)
            ? { allowToolsJson: item.allowToolsJson.map((value) => String(value)) }
            : {}),
          ...(Array.isArray(item.allowSkillsJson)
            ? { allowSkillsJson: item.allowSkillsJson.map((value) => String(value)) }
            : {}),
          ...(asRecord(item.mcpServersJson) ? { mcpServersJson: asRecord(item.mcpServersJson)! } : {}),
          ...(asRecord(item.envJson) ? { envJson: Object.fromEntries(
            Object.entries(asRecord(item.envJson)!).map(([key, val]) => [key, String(val)]),
          ) } : {}),
          ...(asRecord(item.promptConfigJson) ? { promptConfigJson: asRecord(item.promptConfigJson)! } : {}),
        }
      })
      .filter((item): item is RuntimeConfig['agents'][number] => Boolean(item?.agentId)),
  }
}

function validateRuntimeConfig(config: RuntimeConfig): string[] {
  const errors: string[] = []

  const connectorIds = new Set<string>()
  for (const connector of config.connectors) {
    if (!connector.connectorId) errors.push('Connector: connectorId 不能为空')
    if (!connector.connectorType) errors.push(`Connector ${connector.connectorId || '(missing id)'}: connectorType 不能为空`)
    if (connectorIds.has(connector.connectorId)) errors.push(`Connector ${connector.connectorId}: 重复的 connectorId`)
    connectorIds.add(connector.connectorId)
  }

  const agentIds = new Set<string>()
  for (const agent of config.agents) {
    if (!agent.agentId) errors.push('Agent: agentId 不能为空')
    if (!agent.projectDir) errors.push(`Agent ${agent.agentId || '(missing id)'}: projectDir 不能为空`)
    if (agentIds.has(agent.agentId)) errors.push(`Agent ${agent.agentId}: 重复的 agentId`)
    agentIds.add(agent.agentId)
  }

  const channelIds = new Set<string>()
  const channelKeys = new Set<string>()
  const channelSessionIds = new Set<string>()
  for (const channel of config.channels) {
    if (!channel.channelId) errors.push('Channel: channelId 不能为空')
    if (!channel.channelKey) errors.push(`Channel ${channel.channelId || '(missing id)'}: channelKey 不能为空`)
    if (!connectorIds.has(channel.connectorId)) errors.push(`Channel ${channel.channelId}: connectorId 不存在 (${channel.connectorId})`)
    if (!agentIds.has(channel.agentId)) errors.push(`Channel ${channel.channelId}: agentId 不存在 (${channel.agentId})`)
    if (channelIds.has(channel.channelId)) errors.push(`Channel ${channel.channelId}: 重复的 channelId`)

    const scopedKey = `${channel.connectorId}::${channel.channelKey}`
    if (channelKeys.has(scopedKey)) errors.push(`Channel ${channel.channelId}: connector 内部重复的 channelKey (${channel.channelKey})`)

    if (channel.currentSdkSessionId) {
      if (channelSessionIds.has(channel.currentSdkSessionId)) {
        errors.push(`Channel ${channel.channelId}: currentSdkSessionId 已被其他 Channel 使用 (${channel.currentSdkSessionId})`)
      }
      channelSessionIds.add(channel.currentSdkSessionId)
    }

    channelIds.add(channel.channelId)
    channelKeys.add(scopedKey)
  }

  return errors
}

export function registerConfigRoutes(app: Hono<any, any, any>, input: {
  logger: Logger
  configDbPath: string
  configRepository: SqliteConfigRepository
  sessionRegistry: { ensure: (sessionId: string, agentId: string, init?: { channelId?: string }) => void; claimChannel: (sessionId: string, channelId: string) => void; releaseChannel: (channelId: string) => void }
}) {
  app.get('/api/config/overview', (c) => {
    return c.json({
      dbPath: input.configDbPath,
      updatedAt: input.configRepository.getLastUpdatedAt(),
      config: input.configRepository.loadRuntimeConfig(),
    })
  })

  app.put('/api/config/overview', async (c) => {
    const startedAt = Date.now()
    try {
      const body = await c.req.json().catch(() => null)
      const config = toRuntimeConfig(body?.config)
      if (!config) {
        return c.json({ error: 'config is required and must be an object' }, 400)
      }

      const errors = validateRuntimeConfig(config)
      if (errors.length > 0) {
        return c.json({ error: errors.join('；') }, 400)
      }

      input.configRepository.replaceRuntimeConfig(config)
      // Make the binding effective immediately in the current process.
      for (const channel of config.channels) {
        if (channel.currentSdkSessionId) {
          input.sessionRegistry.ensure(channel.currentSdkSessionId, channel.agentId)
          input.sessionRegistry.claimChannel(channel.currentSdkSessionId, channel.channelId)
        } else {
          input.sessionRegistry.releaseChannel(channel.channelId)
        }
      }
      const updatedAt = input.configRepository.getLastUpdatedAt()
      input.logger.info('http:config:save:success', {
        durationMs: Date.now() - startedAt,
        connectors: config.connectors.length,
        agents: config.agents.length,
        channels: config.channels.length,
      })
      return c.json({ ok: true, updatedAt })
    } catch (error) {
      input.logger.error('http:config:save:error', {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      return c.json({ error: error instanceof Error ? error.message : 'Failed to save config' }, 500)
    }
  })
}
