import type {
  AgentConfig,
  ChannelConfig,
  ConnectorConfig,
  RuntimeConfig,
} from './schema.js'
import type { AgentTemplate } from '../orchestration/types.js'

export interface ConfigRegistry {
  getAgent(agentId: string): AgentTemplate | null
  listAgents(): AgentTemplate[]
  getChannel(channelId: string): ChannelConfig | null
  listChannels(): ChannelConfig[]
  getConnector(connectorId: string): ConnectorConfig | null
  listConnectors(): ConnectorConfig[]
}

function toAgentTemplate(agent: AgentConfig): AgentTemplate {
  return {
    agentId: agent.agentId,
    projectDir: agent.projectDir,
    model: agent.modelJson?.model,
    permissionMode: agent.permissionMode,
    allowTools: agent.allowToolsJson,
    allowSkills: agent.allowSkillsJson,
    mcpServers: agent.mcpServersJson,
    env: agent.envJson,
    promptConfig: agent.promptConfigJson,
  }
}

class ConfigSnapshot {
  readonly agents: AgentTemplate[]
  readonly agentById: Map<string, AgentTemplate>
  readonly channels: ChannelConfig[]
  readonly channelById: Map<string, ChannelConfig>
  readonly connectors: ConnectorConfig[]
  readonly connectorById: Map<string, ConnectorConfig>

  constructor(config: RuntimeConfig) {
    this.agents = config.agents.map(toAgentTemplate)
    this.agentById = new Map(this.agents.map((agent) => [agent.agentId, agent]))
    this.channels = config.channels
    this.channelById = new Map(this.channels.map((channel) => [channel.channelId, channel]))
    this.connectors = config.connectors
    this.connectorById = new Map(this.connectors.map((connector) => [connector.connectorId, connector]))
  }
}

export class StaticConfigRegistry implements ConfigRegistry {
  private readonly snapshot: ConfigSnapshot

  private readonly agents: AgentTemplate[]
  private readonly agentById: Map<string, AgentTemplate>
  private readonly channels: ChannelConfig[]
  private readonly channelById: Map<string, ChannelConfig>
  private readonly connectors: ConnectorConfig[]
  private readonly connectorById: Map<string, ConnectorConfig>

  constructor(config: RuntimeConfig) {
    this.snapshot = new ConfigSnapshot(config)
    this.agents = this.snapshot.agents
    this.agentById = this.snapshot.agentById
    this.channels = this.snapshot.channels
    this.channelById = this.snapshot.channelById
    this.connectors = this.snapshot.connectors
    this.connectorById = this.snapshot.connectorById
  }

  getAgent(agentId: string): AgentTemplate | null {
    return this.agentById.get(agentId) ?? null
  }

  listAgents(): AgentTemplate[] {
    return this.agents
  }

  getChannel(channelId: string): ChannelConfig | null {
    return this.channelById.get(channelId) ?? null
  }

  listChannels(): ChannelConfig[] {
    return this.channels
  }

  getConnector(connectorId: string): ConnectorConfig | null {
    return this.connectorById.get(connectorId) ?? null
  }

  listConnectors(): ConnectorConfig[] {
    return this.connectors
  }
}

// Mutable registry used by the runtime so HTTP config updates can take effect without restart.
export class MutableConfigRegistry implements ConfigRegistry {
  private snapshot: ConfigSnapshot

  constructor(config: RuntimeConfig) {
    this.snapshot = new ConfigSnapshot(config)
  }

  update(config: RuntimeConfig): void {
    this.snapshot = new ConfigSnapshot(config)
  }

  getAgent(agentId: string): AgentTemplate | null {
    return this.snapshot.agentById.get(agentId) ?? null
  }

  listAgents(): AgentTemplate[] {
    return this.snapshot.agents
  }

  getChannel(channelId: string): ChannelConfig | null {
    return this.snapshot.channelById.get(channelId) ?? null
  }

  listChannels(): ChannelConfig[] {
    return this.snapshot.channels
  }

  getConnector(connectorId: string): ConnectorConfig | null {
    return this.snapshot.connectorById.get(connectorId) ?? null
  }

  listConnectors(): ConnectorConfig[] {
    return this.snapshot.connectors
  }
}
