import { z } from 'zod'
import type {
  AgentConfig,
  ChannelConfig,
  ConnectorConfig,
  RuntimeConfig,
} from './schema.js'

/**
 * 运行时配置的 Zod schema 定义。
 *
 * 配置面是跨层（HTTP、仓储）共享的真相源，因此把 schema 放到 `runtime/config`
 * 下，避免在 HTTP 路由或仓储层各自手写一份。
 */

const recordStringUnknown = z.record(z.string(), z.unknown())

const ConnectorConfigSchema: z.ZodType<ConnectorConfig> = z.object({
  connectorId: z.string().trim().min(1, 'connectorId 不能为空'),
  connectorType: z.string().trim().min(1, 'connectorType 不能为空'),
  connectorConfig: recordStringUnknown.default({}),
})

const ChannelConfigSchema: z.ZodType<ChannelConfig> = z.object({
  channelId: z.string().trim().min(1, 'channelId 不能为空'),
  channelKey: z.string().trim().min(1, 'channelKey 不能为空'),
  channelName: z.string().trim().min(1).optional(),
  connectorId: z.string().trim().min(1, 'connectorId 不能为空'),
  agentId: z.string().trim().min(1, 'agentId 不能为空'),
  enabled: z.boolean(),
  currentSdkSessionId: z.string().trim().min(1).optional(),
})

const AgentConfigSchema: z.ZodType<AgentConfig> = z.object({
  agentId: z.string().trim().min(1, 'agentId 不能为空'),
  agentName: z.string().trim().min(1).optional(),
  modelJson: z
    .object({
      model: z.string().trim().min(1).optional(),
      thinking: z.unknown().optional(),
      effort: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .default({}),
  projectDir: z.string().trim().min(1, 'projectDir 不能为空'),
  permissionMode: z.string().trim().min(1).optional(),
  allowToolsJson: z.array(z.string()).optional(),
  allowSkillsJson: z.array(z.string()).optional(),
  mcpServersJson: recordStringUnknown.optional(),
  envJson: z.record(z.string(), z.string()).optional(),
  promptConfigJson: recordStringUnknown.optional(),
})

/**
 * 基础结构 schema —— 只做字段形状校验，不做跨实体引用完整性检查。
 * 跨实体校验（例如 channel 引用的 connectorId/agentId 必须存在、
 * currentSdkSessionId 的唯一性）由 `runtimeConfigIntegrityIssues` 负责。
 */
export const RuntimeConfigSchema: z.ZodType<RuntimeConfig> = z.object({
  connectors: z.array(ConnectorConfigSchema).default([]),
  channels: z.array(ChannelConfigSchema).default([]),
  agents: z.array(AgentConfigSchema).default([]),
})

export const RuntimeConfigWrapperSchema = z.object({
  config: RuntimeConfigSchema,
})
export type RuntimeConfigWrapper = z.infer<typeof RuntimeConfigWrapperSchema>

/**
 * 跨实体引用完整性校验。返回的数组为空即表示合法。
 */
export function runtimeConfigIntegrityIssues(config: RuntimeConfig): string[] {
  const errors: string[] = []

  const connectorIds = new Set<string>()
  for (const connector of config.connectors) {
    if (connectorIds.has(connector.connectorId)) {
      errors.push(`Connector ${connector.connectorId}: 重复的 connectorId`)
    }
    connectorIds.add(connector.connectorId)
  }

  const agentIds = new Set<string>()
  for (const agent of config.agents) {
    if (agentIds.has(agent.agentId)) {
      errors.push(`Agent ${agent.agentId}: 重复的 agentId`)
    }
    agentIds.add(agent.agentId)
  }

  const channelIds = new Set<string>()
  const channelKeys = new Set<string>()
  const channelSessionIds = new Set<string>()
  for (const channel of config.channels) {
    if (!connectorIds.has(channel.connectorId)) {
      errors.push(`Channel ${channel.channelId}: connectorId 不存在 (${channel.connectorId})`)
    }
    if (!agentIds.has(channel.agentId)) {
      errors.push(`Channel ${channel.channelId}: agentId 不存在 (${channel.agentId})`)
    }
    if (channelIds.has(channel.channelId)) {
      errors.push(`Channel ${channel.channelId}: 重复的 channelId`)
    }

    const scopedKey = `${channel.connectorId}::${channel.channelKey}`
    if (channelKeys.has(scopedKey)) {
      errors.push(`Channel ${channel.channelId}: connector 内部重复的 channelKey (${channel.channelKey})`)
    }

    if (channel.currentSdkSessionId) {
      if (channelSessionIds.has(channel.currentSdkSessionId)) {
        errors.push(
          `Channel ${channel.channelId}: currentSdkSessionId 已被其他 Channel 使用 (${channel.currentSdkSessionId})`,
        )
      }
      channelSessionIds.add(channel.currentSdkSessionId)
    }

    channelIds.add(channel.channelId)
    channelKeys.add(scopedKey)
  }

  return errors
}
