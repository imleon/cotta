import type Database from 'better-sqlite3'
import type { AgentConfig, ChannelConfig, ConnectorConfig, RuntimeConfig } from '../../config/schema.js'
import { createLogger } from '../../core/logger.js'

const logger = createLogger('sqlite-config-repository')

type ConnectorRow = {
  connector_id: string
  connector_type: string
  connector_config_json: string
}

type AgentRow = {
  agent_id: string
  agent_name: string | null
  project_dir: string
  model_json: string
  permission_mode: string | null
  allow_tools_json: string | null
  allow_skills_json: string | null
  mcp_servers_json: string | null
  env_json: string | null
  prompt_config_json: string | null
}

type ChannelRow = {
  channel_id: string
  channel_key: string
  channel_name: string | null
  connector_id: string
  agent_id: string
  current_sdk_session_id: string | null
  enabled: number
}

function parseJsonObject<T extends Record<string, unknown>>(raw: string | null, fallback: T, field: string): T {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T
    }
    throw new Error(`Expected object JSON in ${field}`)
  } catch (error) {
    logger.error('invalid-persisted-json-object', {
      field,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(`Invalid persisted JSON object in ${field}`)
  }
}

function parseJsonArray<T>(raw: string | null, field: string): T[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed as T[]
    }
    throw new Error(`Expected array JSON in ${field}`)
  } catch (error) {
    logger.error('invalid-persisted-json-array', {
      field,
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error(`Invalid persisted JSON array in ${field}`)
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {})
}

function stringifyJsonNullable(value: unknown): string | null {
  if (value == null) return null
  return JSON.stringify(value)
}

function toConnectorConfig(row: ConnectorRow): ConnectorConfig {
  return {
    connectorId: row.connector_id,
    connectorType: row.connector_type,
    connectorConfig: parseJsonObject(row.connector_config_json, {}, `connectors.${row.connector_id}.connector_config_json`),
  }
}

function toAgentConfig(row: AgentRow): AgentConfig {
  const allowTools = parseJsonArray<string>(row.allow_tools_json, `agents.${row.agent_id}.allow_tools_json`)
  const allowSkills = parseJsonArray<string>(row.allow_skills_json, `agents.${row.agent_id}.allow_skills_json`)
  const mcpServers = parseJsonObject(row.mcp_servers_json, {}, `agents.${row.agent_id}.mcp_servers_json`)
  const env = parseJsonObject<Record<string, string>>(row.env_json, {}, `agents.${row.agent_id}.env_json`)
  const promptConfig = parseJsonObject(row.prompt_config_json, {}, `agents.${row.agent_id}.prompt_config_json`)

  return {
    agentId: row.agent_id,
    ...(row.agent_name ? { agentName: row.agent_name } : {}),
    projectDir: row.project_dir,
    modelJson: parseJsonObject(row.model_json, {}, `agents.${row.agent_id}.model_json`),
    ...(row.permission_mode ? { permissionMode: row.permission_mode } : {}),
    ...(allowTools && allowTools.length > 0 ? { allowToolsJson: allowTools } : {}),
    ...(allowSkills && allowSkills.length > 0 ? { allowSkillsJson: allowSkills } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServersJson: mcpServers } : {}),
    ...(Object.keys(env).length > 0 ? { envJson: env } : {}),
    ...(Object.keys(promptConfig).length > 0 ? { promptConfigJson: promptConfig } : {}),
  }
}

function toChannelConfig(row: ChannelRow): ChannelConfig {
  return {
    channelId: row.channel_id,
    channelKey: row.channel_key,
    ...(row.channel_name ? { channelName: row.channel_name } : {}),
    connectorId: row.connector_id,
    agentId: row.agent_id,
    ...(row.current_sdk_session_id ? { currentSdkSessionId: row.current_sdk_session_id } : {}),
    enabled: Boolean(row.enabled),
  }
}

export class SqliteConfigRepository {
  private readonly listConnectorsStmt: Database.Statement<[], ConnectorRow>
  private readonly listAgentsStmt: Database.Statement<[], AgentRow>
  private readonly listChannelsStmt: Database.Statement<[], ChannelRow>
  private readonly upsertConnectorStmt: Database.Statement
  private readonly upsertAgentStmt: Database.Statement
  private readonly upsertChannelStmt: Database.Statement
  private readonly deleteAllChannelsStmt: Database.Statement
  private readonly deleteAllAgentsStmt: Database.Statement
  private readonly deleteAllConnectorsStmt: Database.Statement
  private readonly getLastUpdatedAtStmt: Database.Statement<[], { updatedAt: number | null }>
  private readonly updateChannelCurrentSdkSessionIdStmt: Database.Statement
  private readonly clearChannelSessionBindingStmt: Database.Statement
  private readonly clearSessionBindingsStmt: Database.Statement
  private readonly bindChannelToSessionTx: (channelId: string, sessionId: string) => void
  private readonly getChannelCurrentSdkSessionIdStmt: Database.Statement<[string], { currentSdkSessionId: string | null } | undefined>

  constructor(private readonly db: Database.Database) {
    this.listConnectorsStmt = db.prepare(`
      SELECT connector_id, connector_type, connector_config_json
      FROM connectors
      ORDER BY connector_id ASC
    `)
    this.listAgentsStmt = db.prepare(`
      SELECT
        agent_id,
        agent_name,
        project_dir,
        model_json,
        permission_mode,
        allow_tools_json,
        allow_skills_json,
        mcp_servers_json,
        env_json,
        prompt_config_json
      FROM agents
      ORDER BY agent_id ASC
    `)
    this.listChannelsStmt = db.prepare(`
      SELECT
        channel_id,
        channel_key,
        channel_name,
        connector_id,
        agent_id,
        current_sdk_session_id,
        enabled
      FROM channels
      ORDER BY channel_id ASC
    `)
    this.upsertConnectorStmt = db.prepare(`
      INSERT INTO connectors (
        connector_id,
        connector_type,
        connector_config_json,
        created_at,
        updated_at
      ) VALUES (
        @connectorId,
        @connectorType,
        @connectorConfigJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(connector_id) DO UPDATE SET
        connector_type = excluded.connector_type,
        connector_config_json = excluded.connector_config_json,
        updated_at = excluded.updated_at
    `)
    this.upsertAgentStmt = db.prepare(`
      INSERT INTO agents (
        agent_id,
        agent_name,
        project_dir,
        model_json,
        permission_mode,
        allow_tools_json,
        allow_skills_json,
        mcp_servers_json,
        env_json,
        prompt_config_json,
        created_at,
        updated_at
      ) VALUES (
        @agentId,
        @agentName,
        @projectDir,
        @modelJson,
        @permissionMode,
        @allowToolsJson,
        @allowSkillsJson,
        @mcpServersJson,
        @envJson,
        @promptConfigJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        agent_name = excluded.agent_name,
        project_dir = excluded.project_dir,
        model_json = excluded.model_json,
        permission_mode = excluded.permission_mode,
        allow_tools_json = excluded.allow_tools_json,
        allow_skills_json = excluded.allow_skills_json,
        mcp_servers_json = excluded.mcp_servers_json,
        env_json = excluded.env_json,
        prompt_config_json = excluded.prompt_config_json,
        updated_at = excluded.updated_at
    `)
    this.upsertChannelStmt = db.prepare(`
      INSERT INTO channels (
        channel_id,
        channel_key,
        channel_name,
        connector_id,
        agent_id,
        current_sdk_session_id,
        enabled,
        created_at,
        updated_at
      ) VALUES (
        @channelId,
        @channelKey,
        @channelName,
        @connectorId,
        @agentId,
        @currentSdkSessionId,
        @enabled,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(channel_id) DO UPDATE SET
        channel_key = excluded.channel_key,
        channel_name = excluded.channel_name,
        connector_id = excluded.connector_id,
        agent_id = excluded.agent_id,
        current_sdk_session_id = excluded.current_sdk_session_id,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `)
    this.deleteAllChannelsStmt = db.prepare('DELETE FROM channels')
    this.deleteAllAgentsStmt = db.prepare('DELETE FROM agents')
    this.deleteAllConnectorsStmt = db.prepare('DELETE FROM connectors')
    this.getLastUpdatedAtStmt = db.prepare(`
      SELECT MAX(updated_at) AS updatedAt
      FROM (
        SELECT updated_at FROM connectors
        UNION ALL
        SELECT updated_at FROM agents
        UNION ALL
        SELECT updated_at FROM channels
      )
    `)
    this.updateChannelCurrentSdkSessionIdStmt = db.prepare(`
      UPDATE channels
      SET current_sdk_session_id = @currentSdkSessionId, updated_at = @updatedAt
      WHERE channel_id = @channelId
    `)
    this.clearChannelSessionBindingStmt = db.prepare(`
      UPDATE channels
      SET current_sdk_session_id = NULL, updated_at = @updatedAt
      WHERE channel_id = @channelId
    `)
    this.clearSessionBindingsStmt = db.prepare(`
      UPDATE channels
      SET current_sdk_session_id = NULL, updated_at = @updatedAt
      WHERE current_sdk_session_id = @sessionId
    `)
    this.getChannelCurrentSdkSessionIdStmt = db.prepare(`
      SELECT current_sdk_session_id AS currentSdkSessionId
      FROM channels
      WHERE channel_id = ?
    `)
    this.bindChannelToSessionTx = db.transaction((channelId: string, sessionId: string) => {
      const updatedAt = Date.now()
      this.clearChannelSessionBindingStmt.run({ channelId, updatedAt })
      this.clearSessionBindingsStmt.run({ sessionId, updatedAt })
      this.updateChannelCurrentSdkSessionIdStmt.run({
        channelId,
        currentSdkSessionId: sessionId,
        updatedAt,
      })
    })
  }

  loadRuntimeConfig(): RuntimeConfig {
    return {
      connectors: this.listConnectors(),
      channels: this.listChannels(),
      agents: this.listAgents(),
    }
  }

  listConnectors(): ConnectorConfig[] {
    return this.listConnectorsStmt.all().map((row: ConnectorRow) => toConnectorConfig(row))
  }

  listAgents(): AgentConfig[] {
    return this.listAgentsStmt.all().map((row: AgentRow) => toAgentConfig(row))
  }

  listChannels(): ChannelConfig[] {
    return this.listChannelsStmt.all().map((row: ChannelRow) => toChannelConfig(row))
  }

  getLastUpdatedAt(): number | null {
    const row = this.getLastUpdatedAtStmt.get()
    return typeof row?.updatedAt === 'number' ? row.updatedAt : null
  }

  getChannelCurrentSdkSessionId(channelId: string): string | null {
    const row = this.getChannelCurrentSdkSessionIdStmt.get(channelId)
    return row?.currentSdkSessionId ?? null
  }

  clearChannelSessionBinding(channelId: string): void {
    this.clearChannelSessionBindingStmt.run({
      channelId,
      updatedAt: Date.now(),
    })
  }

  bindChannelToSession(channelId: string, sessionId: string): void {
    this.bindChannelToSessionTx(channelId, sessionId)
  }

  replaceRuntimeConfig(config: RuntimeConfig): void {
    const now = Date.now()
    const replaceAll = this.db.transaction((nextConfig: RuntimeConfig) => {
      this.deleteAllChannelsStmt.run()
      this.deleteAllAgentsStmt.run()
      this.deleteAllConnectorsStmt.run()

      for (const connector of nextConfig.connectors) {
        this.upsertConnectorStmt.run({
          connectorId: connector.connectorId,
          connectorType: connector.connectorType,
          connectorConfigJson: stringifyJson(connector.connectorConfig),
          createdAt: now,
          updatedAt: now,
        })
      }

      for (const agent of nextConfig.agents) {
        this.upsertAgentStmt.run({
          agentId: agent.agentId,
          agentName: agent.agentName ?? null,
          projectDir: agent.projectDir,
          modelJson: stringifyJson(agent.modelJson),
          permissionMode: agent.permissionMode ?? null,
          allowToolsJson: stringifyJsonNullable(agent.allowToolsJson),
          allowSkillsJson: stringifyJsonNullable(agent.allowSkillsJson),
          mcpServersJson: stringifyJsonNullable(agent.mcpServersJson),
          envJson: stringifyJsonNullable(agent.envJson),
          promptConfigJson: stringifyJsonNullable(agent.promptConfigJson),
          createdAt: now,
          updatedAt: now,
        })
      }

      for (const channel of nextConfig.channels) {
        this.upsertChannelStmt.run({
          channelId: channel.channelId,
          channelKey: channel.channelKey,
          channelName: channel.channelName ?? null,
          connectorId: channel.connectorId,
          agentId: channel.agentId,
          currentSdkSessionId: channel.currentSdkSessionId ?? null,
          enabled: channel.enabled ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        })
      }
    })

    replaceAll(config)
  }
}
